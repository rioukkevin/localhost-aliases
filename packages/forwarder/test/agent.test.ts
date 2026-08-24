/**
 * The root agent's reconciliation loop.
 *
 * NOTHING HERE TOUCHES THE MACHINE. `SystemOps` is injected as a recording fake, so every
 * ifconfig and every /etc/hosts write is an assertion about an array rather than an edit to
 * this laptop. The forwarder is real, binds 127.0.0.1 on ports above 1024, and is driven
 * only through `setRoutes`.
 *
 * The tests are grouped by the promise each one keeps: reconcile without a prompt, refuse a
 * hostile file leaving the previous state intact, and never remove something that is not ours.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HOSTS_BEGIN, HOSTS_END } from "@localhost-aliases/core/types";
import { Agent, outsideBlockChanged } from "../src/agent.ts";
import { Forwarder } from "../src/forwarder.ts";
import {
  SYSTEM_HOSTS,
  cleanup,
  desiredState,
  fakeSystem,
  freePort,
  httpGet,
  tempDir,
  waitFor,
  type FakeSystem,
} from "./helpers.ts";

let dir: string;
let stateFile: string;
let statusFile: string;
let system: FakeSystem;
let forwarder: Forwarder;
let agent: Agent;

/** The managed block as the agent should have rendered it. */
function block(...lines: string[]): string {
  return `${HOSTS_BEGIN}\n${lines.map((l) => `${l}\n`).join("")}${HOSTS_END}\n`;
}

async function writeState(state: unknown): Promise<void> {
  await Bun.write(stateFile, typeof state === "string" ? state : JSON.stringify(state, null, 2));
}

async function makeAgent(options: { managedIps?: string[] } = {}): Promise<void> {
  forwarder = new Forwarder({ statusFile, watchRoutesFile: false, pollMs: 50, log: () => {} });
  await forwarder.start();
  agent = new Agent({
    forwarder,
    system,
    desiredStateFile: stateFile,
    hostsPath: "/fake/hosts",
    managedIps: options.managedIps,
    pollMs: 50,
    log: () => {},
  });
}

beforeEach(async () => {
  dir = await tempDir();
  stateFile = join(dir, "desired-state.json");
  statusFile = join(dir, "forwarder-status.json");
  system = fakeSystem();
});

afterEach(async () => {
  await agent?.stop();
  await forwarder?.stop();
  await cleanup(dir);
});

describe("reconciling, with no prompt anywhere", () => {
  test("adds the addresses, writes the block, flushes DNS and binds the routes", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") });
    const listenPort = freePort();
    await writeState({
      hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [{ ip: "127.0.0.1", listenPort, targetPort: upstream.port!, hostname: "myapp.test" }],
    });

    await makeAgent();
    const result = await agent.start();

    expect(result.ok).toBe(true);
    expect(result.added).toEqual(["127.0.0.2"]);
    expect(result.hostsChanged).toBe(true);
    expect(result.dnsFlushed).toBe(true);
    expect(system.lo0).toEqual(["127.0.0.1", "127.0.0.2"]);
    expect(system.hosts).toBe(SYSTEM_HOSTS + block("127.0.0.2\tmyapp.test"));
    expect(system.calls).toContain("flushDns");

    // The route is really bound, not just recorded.
    expect(await httpGet(listenPort)).toBe("hi");
    upstream.stop(true);
  });

  test("a change to the file is picked up on its own", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();
    expect(system.lo0).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);

    // The dashboard adds an alias. Nobody types a password.
    await writeState({
      hosts: [
        { ip: "127.0.0.2", hostname: "index.test" },
        { ip: "127.0.0.3", hostname: "myapp.test" },
        { ip: "127.0.0.4", hostname: "shop.test" },
      ],
      loopbackIps: ["127.0.0.2", "127.0.0.3", "127.0.0.4"],
      routes: [],
    });

    await waitFor(() => system.lo0.includes("127.0.0.4"), { what: "127.0.0.4 to be added" });
    await waitFor(() => system.hosts.includes("shop.test"), { what: "shop.test in the hosts block" });
    expect(system.hosts).toBe(
      SYSTEM_HOSTS +
        block("127.0.0.2\tindex.test", "127.0.0.3\tmyapp.test", "127.0.0.4\tshop.test"),
    );
  });

  test("removing an alias removes its address and its line", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();

    await writeState({
      hosts: [{ ip: "127.0.0.2", hostname: "index.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
    const result = await agent.reconcile();

    expect(result.removed).toEqual(["127.0.0.3"]);
    expect(system.lo0).toEqual(["127.0.0.1", "127.0.0.2"]);
    expect(system.hosts).toBe(SYSTEM_HOSTS + block("127.0.0.2\tindex.test"));
  });

  test("an unchanged state writes nothing and flushes nothing", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();
    expect(system.hostsWrites).toBe(1);

    const again = await agent.reconcile();
    expect(again.ok).toBe(true);
    expect(again.hostsChanged).toBe(false);
    expect(again.dnsFlushed).toBe(false);
    expect(system.hostsWrites).toBe(1);
  });

  test("a port-only change retargets without rebinding or touching the system", async () => {
    const one = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("one") });
    const two = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("two") });
    const listenPort = freePort();
    const state = (target: number) => ({
      hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [{ ip: "127.0.0.1", listenPort, targetPort: target, hostname: "myapp.test" }],
    });

    await writeState(state(one.port!));
    await makeAgent();
    await agent.start();
    expect(await httpGet(listenPort)).toBe("one");

    await writeState(state(two.port!));
    const result = await agent.reconcile();
    expect(result.hostsChanged).toBe(false);
    expect(result.dnsFlushed).toBe(false);
    expect(await httpGet(listenPort)).toBe("two");

    one.stop(true);
    two.stop(true);
  });
});

describe("a hostile or broken file leaves the previous state intact", () => {
  /** Reconcile a good state, then feed it `bad` and assert nothing moved. */
  async function afterPoison(bad: unknown): Promise<{ hosts: string; lo0: string[]; rejected: string[] }> {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();
    const hostsBefore = system.hosts;
    const lo0Before = [...system.lo0];
    const writesBefore = system.hostsWrites;

    await writeState(bad);
    const result = await agent.reconcile();

    expect(result.ok).toBe(false);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(system.hosts).toBe(hostsBefore);
    expect(system.lo0).toEqual(lo0Before);
    expect(system.hostsWrites).toBe(writesBefore);
    return { hosts: system.hosts, lo0: system.lo0, rejected: result.rejected };
  }

  test("a newline in a hostname", async () => {
    const { rejected, hosts } = await afterPoison(
      desiredState({
        hosts: [{ ip: "127.0.0.2", hostname: "evil.test\n127.0.0.1\tbank.example.com" }],
        routes: [],
      }),
    );
    expect(rejected[0]).toContain("invalid hostname");
    expect(hosts).not.toContain("bank.example.com");
  });

  test("127.0.0.1 in loopbackIps", async () => {
    const { rejected, lo0 } = await afterPoison(
      desiredState({ loopbackIps: ["127.0.0.1"], hosts: [], routes: [] }),
    );
    expect(rejected[0]).toContain("outside 127.0.0.2-254");
    expect(lo0).toContain("127.0.0.1"); // still there, untouched
  });

  test("an address outside the pool", async () => {
    const { rejected } = await afterPoison(
      desiredState({ loopbackIps: ["10.0.0.7"], hosts: [], routes: [] }),
    );
    expect(rejected[0]).toContain("outside 127.0.0.2-254");
  });

  test("a route pointed at a non-loopback address", async () => {
    const { rejected } = await afterPoison(
      desiredState({ routes: [{ ip: "192.168.1.20", listenPort: 80, targetPort: 3000, hostname: "a.test" }] }),
    );
    expect(rejected[0]).toContain("not a loopback address");
  });

  test("truncated JSON, as a half-finished write would leave", async () => {
    const { rejected } = await afterPoison('{"hosts": [{"ip": "127.0.0.2",');
    expect(rejected[0]).toContain("not valid JSON");
  });

  test("an empty file is not an instruction to remove everything", async () => {
    const { rejected } = await afterPoison("");
    expect(rejected[0]).toContain("empty");
  });

  test("a missing file leaves the machine as it is", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();
    const before = system.hosts;

    await Bun.file(stateFile).delete();
    const result = await agent.reconcile();
    expect(result.ok).toBe(false);
    expect(result.rejected[0]).toContain("missing");
    expect(system.hosts).toBe(before);
    expect(system.lo0).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
  });
});

describe("/etc/hosts is only ever edited between the markers", () => {
  test("the guard itself: any byte outside the markers is a refusal", () => {
    const current = SYSTEM_HOSTS + block("127.0.0.2\tindex.test");
    // The honest rewrite: only the block moved.
    expect(outsideBlockChanged(current, SYSTEM_HOSTS + block("127.0.0.3\tother.test"))).toBe(false);
    // Removing the block entirely is still only the block.
    expect(outsideBlockChanged(current, SYSTEM_HOSTS)).toBe(false);

    // Everything below is a rewrite that reached outside, and every one must be refused.
    expect(outsideBlockChanged(current, current.replace("127.0.0.1\tlocalhost", "127.0.0.1\tevil"))).toBe(true);
    expect(outsideBlockChanged(current, current.replace("# Host Database", ""))).toBe(true);
    expect(outsideBlockChanged(current, `${current}10.0.0.1\tsomething.new\n`)).toBe(true);
    expect(outsideBlockChanged(current, "")).toBe(true);
    // A single byte is enough.
    expect(outsideBlockChanged(current, current.replace("broadcasthost", "broadcasthosT"))).toBe(true);
  });

  test("a file that changed under the agent's feet is not overwritten", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();

    // Something else edits /etc/hosts between the render and the write. Reverting that
    // edit silently would be worse than doing nothing.
    let reads = 0;
    system.readHosts = async () => {
      reads += 1;
      return reads === 1 ? SYSTEM_HOSTS : `${SYSTEM_HOSTS}# added by the VPN client\n`;
    };
    const result = await agent.start();

    expect(result.hostsChanged).toBe(false);
    expect(system.hostsWrites).toBe(0);
  });

  test("everything outside the markers survives verbatim, including a pre-existing block", async () => {
    const before = [
      "127.0.0.1\tlocalhost",
      "# a comment the user wrote",
      HOSTS_BEGIN,
      "127.0.0.9\told.test",
      HOSTS_END,
      "10.0.0.5\tnas.lan",
      "",
    ].join("\n");
    system = fakeSystem({ hosts: before });
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();

    const outside = system.hosts.split(HOSTS_BEGIN)[0]! + system.hosts.split(HOSTS_END)[1]!;
    expect(outside).toBe("127.0.0.1\tlocalhost\n# a comment the user wrote\n" + "\n10.0.0.5\tnas.lan\n");
    expect(system.hosts).toContain("127.0.0.2\tindex.test");
    expect(system.hosts).not.toContain("old.test");
  });

  test("an unwritable hosts file is survived, and the routes still come up", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("up") });
    const listenPort = freePort();
    await writeState({
      hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [{ ip: "127.0.0.1", listenPort, targetPort: upstream.port!, hostname: "myapp.test" }],
    });
    await makeAgent();
    system.failNext.add("writeHosts");

    const result = await agent.start();
    expect(result.ok).toBe(true);
    expect(result.hostsChanged).toBe(false);
    expect(await httpGet(listenPort)).toBe("up");
    upstream.stop(true);
  });
});

describe("addresses the agent did not allocate", () => {
  test("a pool address it never allocated is left alone", async () => {
    // The user added 127.0.0.9 by hand for something unrelated.
    system = fakeSystem({ lo0: ["127.0.0.1", "127.0.0.9"] });
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    const result = await agent.start();

    expect(result.removed).toEqual([]);
    expect(system.lo0).toContain("127.0.0.9");
    expect(system.calls).not.toContain("remove 127.0.0.9");
  });

  test("LA_MANAGED_IPS hands over the addresses this install allocated", async () => {
    system = fakeSystem({ lo0: ["127.0.0.1", "127.0.0.9"] });
    await writeState(desiredState({ routes: [] }));
    await makeAgent({ managedIps: ["127.0.0.9"] });
    const result = await agent.start();

    expect(result.removed).toEqual(["127.0.0.9"]);
    expect(system.lo0).not.toContain("127.0.0.9");
  });

  test("an address it added itself is later removed", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    await agent.start();
    expect(agent.ownedIps).toEqual(["127.0.0.2", "127.0.0.3"]);

    await writeState({ hosts: [], loopbackIps: [], routes: [] });
    const result = await agent.reconcile();
    expect(result.removed).toEqual(["127.0.0.2", "127.0.0.3"]);
    expect(system.lo0).toEqual(["127.0.0.1"]);
    expect(agent.ownedIps).toEqual([]);
  });

  test("127.0.0.1 is never a removal candidate, even with everything removed", async () => {
    await writeState({ hosts: [], loopbackIps: [], routes: [] });
    await makeAgent({ managedIps: ["127.0.0.1"] }); // even if someone tries to hand it over
    await agent.start();
    expect(system.lo0).toEqual(["127.0.0.1"]);
    expect(system.calls.join(" ")).not.toContain("remove 127.0.0.1");
  });

  test("a wedged ifconfig stops the pass instead of guessing", async () => {
    await writeState(desiredState({ routes: [] }));
    await makeAgent();
    system.failNext.add("list");
    const result = await agent.reconcile();
    expect(result.ok).toBe(false);
    expect(result.rejected[0]).toContain("could not read lo0");
    expect(system.hostsWrites).toBe(0);
  });
});
