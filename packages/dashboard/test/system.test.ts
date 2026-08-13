import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { buildDesiredState, DEFAULT_CONFIG, type Config, type DesiredState } from "@localhost-aliases/core";
import { compare, defaultProbes, observe, pidAlive, readSystemState } from "../lib/system.ts";
import { appliedProbes, forwarderFor, sandbox, stubProbes, type Sandbox } from "./helpers.ts";

let box: Sandbox;

beforeEach(async () => {
  box = await sandbox();
});
afterEach(() => box.cleanup());

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    aliases: [
      {
        id: "a1",
        name: "index",
        port: 7788,
        ip: "127.0.0.2",
        projectPath: null,
        description: null,
        enabled: true,
        reserved: true,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "a2",
        name: "shop",
        port: 3000,
        ip: "127.0.0.3",
        projectPath: "/tmp/shop",
        description: null,
        enabled: true,
        reserved: false,
        createdAt: "",
        updatedAt: "",
      },
    ],
  };
}

function desired(): DesiredState {
  return buildDesiredState(config());
}

describe("observe", () => {
  test("parses lo0, the managed hosts block and the forwarder status", async () => {
    const d = desired();
    const observation = await observe(appliedProbes(d));

    expect(observation.loopbackIps).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
    expect(observation.hostsEntries).toEqual([
      { ip: "127.0.0.2", hostname: "index.local" },
      { ip: "127.0.0.3", hostname: "shop.local" },
    ]);
    expect(observation.forwarder?.routes).toHaveLength(2);
    expect(observation.staleStatus).toBe(false);
  });

  test("a status file whose process is gone counts as no forwarder", async () => {
    const d = desired();
    const observation = await observe(
      stubProbes({ loopbackIps: d.loopbackIps, hosts: d.hosts, forwarder: forwarderFor(d), pidAlive: false }),
    );
    expect(observation.forwarder).toBeNull();
    expect(observation.staleStatus).toBe(true);
  });

  test("garbage in forwarder-status.json is ignored rather than thrown", async () => {
    const observation = await observe(
      stubProbes({ forwarder: { nonsense: true } as unknown as null }),
    );
    expect(observation.forwarder).toBeNull();
    expect(observation.staleStatus).toBe(false);
  });

  test("the default hosts probe reads LA_HOSTS_PATH, never /etc/hosts directly", async () => {
    await writeFile(
      box.hostsPath,
      "# >>> localhost-aliases >>>\n127.0.0.9\tfake.local\n# <<< localhost-aliases <<<\n",
    );
    const text = await defaultProbes.hostsFile();
    expect(text).toContain("fake.local");
  });
});

describe("pidAlive", () => {
  test("true for this process, false for a pid that cannot exist", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(4_194_303)).toBe(false);
  });
});

describe("compare", () => {
  test("a fully applied machine reports no drift", async () => {
    const d = desired();
    const live = await readSystemState(d, appliedProbes(d));

    expect(live.system.applied).toBe(true);
    expect(live.system.drift).toEqual([]);
    expect(live.diff.needsPrompt).toBe(false);
    expect(live.system.managedHosts).toEqual(["index.local", "shop.local"]);
  });

  test("missing lo0 addresses need the admin prompt", async () => {
    const d = desired();
    const live = await readSystemState(
      d,
      stubProbes({ loopbackIps: ["127.0.0.1"], hosts: d.hosts, forwarder: forwarderFor(d) }),
    );

    expect(live.diff.needsPrompt).toBe(true);
    expect(live.diff.privileged.join(" ")).toContain("Missing loopback");
    expect(live.system.applied).toBe(false);
  });

  test("a target-port change alone never prompts", async () => {
    const d = desired();
    const stale = { ...d, routes: d.routes.map((r) => ({ ...r, targetPort: r.targetPort + 1 })) };
    const live = await readSystemState(
      d,
      stubProbes({ loopbackIps: d.loopbackIps, hosts: d.hosts, forwarder: forwarderFor(stale) }),
    );

    expect(live.diff.needsPrompt).toBe(false);
    expect(live.diff.privileged).toEqual([]);
    expect(live.diff.unprivileged).toHaveLength(2);
    expect(live.system.applied).toBe(false);
  });

  test("a hosts line pointing at the wrong IP is reported, which core alone cannot see", async () => {
    const d = desired();
    const wrong = d.hosts.map((h) => (h.hostname === "shop.local" ? { ...h, ip: "127.0.0.9" } : h));
    const live = await readSystemState(
      d,
      stubProbes({ loopbackIps: d.loopbackIps, hosts: wrong, forwarder: forwarderFor(d) }),
    );

    expect(live.diff.needsPrompt).toBe(true);
    expect(live.diff.privileged).toContain("/etc/hosts points shop.local at 127.0.0.9, expected 127.0.0.3.");
  });

  test("a stale status file is named in the drift, not just 'not running'", async () => {
    const d = desired();
    const live = await readSystemState(
      d,
      stubProbes({ loopbackIps: d.loopbackIps, hosts: d.hosts, forwarder: forwarderFor(d), pidAlive: false }),
    );

    expect(live.diff.privileged).toContain("The forwarder is not running.");
    expect(live.diff.privileged).toContain("The forwarder left a status file behind but its process is gone.");
  });

  test("no desired state yet means nothing to compare against", () => {
    const live = compare(
      { loopbackIps: ["127.0.0.1"], hostsEntries: [], forwarder: null, staleStatus: false },
      null,
    );
    expect(live.system.applied).toBe(true);
    expect(live.diff.drift).toEqual([]);
  });
});
