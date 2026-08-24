import { describe, expect, test, afterEach } from "bun:test";
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOSTS_BEGIN, HOSTS_END } from "@localhost-aliases/core/types";
import { APPLY, PRIV_DIR, STATE_TWO, SYSTEM_HOSTS, killSandboxProcesses, makeSandbox, run, type Sandbox } from "./helpers.ts";

const sandboxes: Sandbox[] = [];
function sandbox(): Sandbox {
  const s = makeSandbox();
  sandboxes.push(s);
  return s;
}
afterEach(() => {
  while (sandboxes.length > 0) killSandboxProcesses(sandboxes.pop()!);
});

const apply = (s: Sandbox, args: string[] = [], extra: Record<string, string> = {}) =>
  run(["/bin/bash", APPLY, ...args], s.env(extra));

describe("markers", () => {
  test("the shell constants are the ones core writes", () => {
    const lib = readFileSync(join(PRIV_DIR, "lib.sh"), "utf8");
    expect(lib).toContain(`LA_BEGIN_MARKER='${HOSTS_BEGIN}'`);
    expect(lib).toContain(`LA_END_MARKER='${HOSTS_END}'`);
  });
});

describe("apply.sh, first run", () => {
  test("adds lo0 aliases, writes the block, flushes DNS and starts the forwarder", async () => {
    const s = sandbox();
    const state = s.writeState(STATE_TWO);
    const r = await apply(s, [state]);

    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({
      status: "ok",
      ips_added: "2",
      ips_removed: "0",
      hosts: "changed",
      dns: "flushed",
      forwarder: "started",
    });
    expect(Number(r.summary.pid)).toBeGreaterThan(1);

    expect(s.calls("ifconfig")).toContain("lo0 alias 127.0.0.2 netmask 255.255.255.255 up");
    expect(s.calls("ifconfig")).toContain("lo0 alias 127.0.0.3 netmask 255.255.255.255 up");
    expect(s.lo0()).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);

    expect(s.hosts()).toBe(
      `${SYSTEM_HOSTS}${HOSTS_BEGIN}\n127.0.0.2\tindex.test\n127.0.0.3\tmyapp.test\n${HOSTS_END}\n`,
    );
    expect(s.calls("dscacheutil")).toEqual(["-flushcache"]);
    expect(s.calls("killall")).toEqual(["-HUP mDNSResponder"]);
    expect(readFileSync(join(s.root, "forwarder.calls"), "utf8")).toContain(`config=${s.configDir}`);
  });

  test("writes /etc/hosts atomically: 0644 and no temp file left behind", async () => {
    const s = sandbox();
    await apply(s, [s.writeState(STATE_TWO)]);
    expect(statSync(s.hostsPath).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(s.root, "etc"))).toEqual(["hosts"]);
  });

  test("keeps a first-run copy of the original hosts file", async () => {
    const s = sandbox();
    await apply(s, [s.writeState(STATE_TWO)]);
    expect(readFileSync(join(s.configDir, "hosts.original"), "utf8")).toBe(SYSTEM_HOSTS);
  });

  test("--no-forwarder does everything except start the forwarder", async () => {
    const s = sandbox();
    const r = await apply(s, ["--no-forwarder", s.writeState(STATE_TWO)]);
    expect(r.summary.forwarder).toBe("skipped");
    expect(s.hosts()).toContain("myapp.test");
    expect(existsSync(join(s.root, "forwarder.calls"))).toBe(false);
  });
});

describe("apply.sh, idempotence", () => {
  test("a second identical run changes nothing and reuses the running forwarder", async () => {
    const s = sandbox();
    const state = s.writeState(STATE_TWO);
    const first = await apply(s, [state]);
    const before = s.hosts();

    const second = await apply(s, [state]);
    expect(second.code).toBe(0);
    expect(second.summary).toMatchObject({
      ips_added: "0",
      ips_removed: "0",
      hosts: "unchanged",
      forwarder: "running",
    });
    expect(second.summary.pid).toBe(first.summary.pid);
    expect(s.hosts()).toBe(before);
    expect(s.calls("ifconfig").filter((c) => c.includes("alias"))).toHaveLength(2);
  });

  test("a stale status file is never trusted: an unrelated pid is not adopted", async () => {
    const s = sandbox();
    writeFileSync(
      join(s.configDir, "forwarder-status.json"),
      JSON.stringify({ pid: process.pid, startedAt: "x", routes: [], failures: [] }),
    );
    const r = await apply(s, [s.writeState(STATE_TWO)]);
    expect(r.summary.forwarder).toBe("started");
    expect(r.summary.pid).not.toBe(String(process.pid));
  });
});

describe("apply.sh, changes", () => {
  test("removing an alias removes its lo0 address and its hosts line, and restarts the forwarder", async () => {
    const s = sandbox();
    await apply(s, [s.writeState(STATE_TWO)]);
    const smaller = {
      hosts: [{ ip: "127.0.0.2", hostname: "index.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    };
    const r = await apply(s, [s.writeState(smaller)]);

    expect(r.summary).toMatchObject({ ips_added: "0", ips_removed: "1", hosts: "changed", forwarder: "restarted" });
    expect(s.calls("ifconfig")).toContain("lo0 -alias 127.0.0.3");
    expect(s.lo0()).toEqual(["127.0.0.1", "127.0.0.2"]);
    expect(s.hosts()).not.toContain("myapp.test");
    expect(s.hosts()).toContain("index.test");
  });

  test("127.0.0.1 is never removed, and neither is anything outside the pool", async () => {
    const s = sandbox();
    s.setLo0(["127.0.0.1", "127.0.0.9", "10.0.0.5"]);
    const r = await apply(s, [s.writeState(STATE_TWO)]);
    expect(r.code).toBe(0);
    expect(s.calls("ifconfig")).toContain("lo0 -alias 127.0.0.9");
    expect(s.calls("ifconfig").join("\n")).not.toContain("-alias 127.0.0.1\n");
    expect(s.lo0()).toContain("127.0.0.1");
    expect(s.lo0()).toContain("10.0.0.5");
  });

  test("LA_MANAGED_IPS keeps pool addresses we did not allocate", async () => {
    const s = sandbox();
    s.setLo0(["127.0.0.1", "127.0.0.7", "127.0.0.8"]);
    const r = await apply(s, [s.writeState(STATE_TWO)], { LA_MANAGED_IPS: "127.0.0.2 127.0.0.3 127.0.0.8" });
    expect(r.summary.ips_removed).toBe("1");
    expect(s.lo0()).toContain("127.0.0.7");
    expect(s.lo0()).not.toContain("127.0.0.8");
  });

  test("an empty desired state strips the block and leaves the file otherwise identical", async () => {
    const s = sandbox();
    await apply(s, [s.writeState(STATE_TWO)]);
    const r = await apply(s, [s.writeState({ hosts: [], loopbackIps: [], routes: [] })]);
    expect(r.code).toBe(0);
    expect(s.hosts()).toBe(SYSTEM_HOSTS);
    expect(r.summary.forwarder).toBe("idle");
  });
});

describe("apply.sh, /etc/hosts is not ours to mangle", () => {
  test("content after the block survives byte-for-byte", async () => {
    const s = sandbox();
    const tail = "# added by hand\n10.1.2.3\tstaging.internal\n";
    writeFileSync(s.hostsPath, `${SYSTEM_HOSTS}${HOSTS_BEGIN}\n127.0.0.9\told.test\n${HOSTS_END}\n${tail}`);
    await apply(s, [s.writeState(STATE_TWO)]);
    expect(s.hosts()).toBe(
      `${SYSTEM_HOSTS}${HOSTS_BEGIN}\n127.0.0.2\tindex.test\n127.0.0.3\tmyapp.test\n${HOSTS_END}\n${tail}`,
    );
  });

  test("duplicate blocks collapse into one", async () => {
    const s = sandbox();
    writeFileSync(
      s.hostsPath,
      `${SYSTEM_HOSTS}${HOSTS_BEGIN}\n127.0.0.9\ta.test\n${HOSTS_END}\nmiddle\n${HOSTS_BEGIN}\n127.0.0.8\tb.test\n${HOSTS_END}\n`,
    );
    await apply(s, [s.writeState(STATE_TWO)]);
    const out = s.hosts();
    expect(out.split(HOSTS_BEGIN).length - 1).toBe(1);
    expect(out).toContain("middle\n");
    expect(out).not.toContain("a.test");
    expect(out).not.toContain("b.test");
  });

  test("a file with no trailing newline still gets a well-formed block", async () => {
    const s = sandbox();
    writeFileSync(s.hostsPath, "127.0.0.1\tlocalhost");
    await apply(s, [s.writeState(STATE_TWO)]);
    expect(s.hosts()).toBe(
      `127.0.0.1\tlocalhost\n${HOSTS_BEGIN}\n127.0.0.2\tindex.test\n127.0.0.3\tmyapp.test\n${HOSTS_END}\n`,
    );
  });
});

describe("apply.sh, hostile desired state", () => {
  const rejects = async (state: unknown, step = "desired-state") => {
    const s = sandbox();
    const before = s.hosts();
    const r = await apply(s, [s.writeState(state)]);
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe(`LA_RESULT status=error step=${step}`);
    expect(r.stderr).toContain(`LA_ERROR step=${step} message=`);
    expect(s.hosts()).toBe(before);
    expect(s.calls("ifconfig").join("\n")).not.toContain("alias");
    return r;
  };

  test("a hostname carrying shell metacharacters", async () => {
    await rejects({
      hosts: [{ ip: "127.0.0.2", hostname: "a.test; touch /tmp/pwned" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
  });

  test("a hostname carrying a newline and a second entry", async () => {
    await rejects({
      hosts: [{ ip: "127.0.0.2", hostname: "a.test\n8.8.8.8\tgoogle.com" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
  });

  test("an address outside the pool", async () => {
    await rejects({ hosts: [], loopbackIps: ["8.8.8.8"], routes: [] });
  });

  test("127.0.0.1 itself", async () => {
    await rejects({ hosts: [], loopbackIps: ["127.0.0.1"], routes: [] });
  });

  test("a non-canonical address", async () => {
    await rejects({ hosts: [], loopbackIps: ["127.0.0.02"], routes: [] });
  });

  test("hijacking localhost", async () => {
    await rejects({
      hosts: [{ ip: "127.0.0.2", hostname: "localhost" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
  });

  test("an uppercase hostname", async () => {
    await rejects({
      hosts: [{ ip: "127.0.0.2", hostname: "MyApp.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
  });

  test("the same hostname twice", async () => {
    await rejects({
      hosts: [
        { ip: "127.0.0.2", hostname: "a.test" },
        { ip: "127.0.0.2", hostname: "a.test" },
      ],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
  });

  test("a hosts entry whose address is not being brought up", async () => {
    await rejects({
      hosts: [{ ip: "127.0.0.5", hostname: "a.test" }],
      loopbackIps: ["127.0.0.2"],
      routes: [],
    });
  });

  test("a state file that is not JSON", async () => {
    const s = sandbox();
    const path = join(s.root, "broken.json");
    writeFileSync(path, "not json at all");
    const r = await apply(s, [path]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("LA_ERROR step=desired-state");
  });

  test("more entries than the machine could ever have", async () => {
    const many = Array.from({ length: 600 }, (_, i) => `127.0.0.${(i % 250) + 2}`);
    await rejects({ hosts: [], loopbackIps: many, routes: [] });
  });

  // Regression: la_is_hostname splits on "." with `for label in $host`, which also
  // glob-expands. Run from a directory full of label-shaped filenames, "*" used to
  // expand to those names, every one of them passed, and "*" validated as a hostname.
  // The split must never consult the filesystem.
  test("a glob hostname, run from a directory whose filenames all look like labels", async () => {
    const s = sandbox();
    const cwd = join(s.root, "globby");
    mkdirSync(cwd, { recursive: true });
    for (const name of ["local", "myapp", "index", "com"]) writeFileSync(join(cwd, name), "");
    const before = s.hosts();

    for (const hostname of ["*", "*.test", "?", "[a-z]"]) {
      const state = join(s.root, "glob-state.json");
      writeFileSync(state, JSON.stringify({ hosts: [{ ip: "127.0.0.2", hostname }], loopbackIps: ["127.0.0.2"], routes: [] }));
      const proc = Bun.spawn(["/bin/bash", APPLY, state], { cwd, env: s.env(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, `hostname ${JSON.stringify(hostname)} was accepted`).not.toBe(0);
      expect(stdout.trim()).toBe("LA_RESULT status=error step=desired-state");
      expect(stderr).toContain("LA_ERROR step=desired-state");
    }
    expect(s.hosts()).toBe(before);
    expect(s.calls("ifconfig").join("\n")).not.toContain("alias");
  });
});

describe("apply.sh, argument and environment errors", () => {
  test("no state file", async () => {
    const s = sandbox();
    const r = await apply(s, []);
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("LA_RESULT status=error step=arguments");
    expect(r.stderr).toContain("usage:");
  });

  test("a missing state file", async () => {
    const s = sandbox();
    const r = await apply(s, [join(s.root, "nope.json")]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no such desired-state file");
  });

  test("an unknown option", async () => {
    const s = sandbox();
    const r = await apply(s, ["--wipe-disk", s.writeState(STATE_TWO)]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('unknown option "--wipe-disk"');
  });

  test("no LA_CONFIG_DIR", async () => {
    const s = sandbox();
    const env = s.env();
    delete (env as Record<string, string | undefined>).LA_CONFIG_DIR;
    const r = await run(["/bin/bash", APPLY, s.writeState(STATE_TWO)], env as Record<string, string>);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("LA_CONFIG_DIR is not set");
  });

  test("no LA_FORWARDER", async () => {
    const s = sandbox();
    const env = s.env();
    delete (env as Record<string, string | undefined>).LA_FORWARDER;
    const r = await run(["/bin/bash", APPLY, s.writeState(STATE_TWO)], env as Record<string, string>);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("LA_FORWARDER is not set");
  });

  test("a forwarder that dies immediately is reported, not ignored", async () => {
    const s = sandbox();
    const dead = join(s.root, "dead-forwarder");
    writeFileSync(dead, "#!/bin/bash\nexit 3\n", { mode: 0o755 });
    const r = await apply(s, [s.writeState(STATE_TWO)], { LA_FORWARDER: dead });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("LA_ERROR step=forwarder");
    expect(r.stderr).toContain("exited immediately");
  });
});
