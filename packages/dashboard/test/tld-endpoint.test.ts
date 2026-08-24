/**
 * The TLD blocklist at the HTTP boundary.
 *
 * tld.test.ts covers the pure predicate; this covers the layer a user actually reaches:
 * the real settings endpoint must answer 400 with the SAME sentence blockedTldReason gives,
 * no other route may smuggle a blocked suffix in, and loading a config that still says
 * .local must coerce silently — never queueing a privileged run, because an unsolicited
 * admin prompt at startup is the worst possible outcome here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_TLD, HSTS_PRELOADED_TLDS, ValidationError, blockedTldReason, buildDesiredState,
  loadConfig, updateSettings,
} from "@localhost-aliases/core";
import { sandbox, stubProbes, type Sandbox } from "./helpers.ts";

let box: Sandbox;
const BASE = { version: 2, tld: "test", dashboardPort: 3000, https: false, autoApply: false, aliases: [] };

async function seed(config: Record<string, unknown>) {
  await mkdir(box.configDir, { recursive: true });
  await writeFile(join(box.configDir, "config.json"), JSON.stringify(config, null, 2));
}
async function filesIn(): Promise<string[]> {
  try { return (await readdir(box.configDir)).sort(); } catch { return []; }
}
function settingsReq(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/settings", {
    method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
}
function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  return fn().then((value) => ({ value, warnings })).finally(() => { console.warn = warn; });
}

beforeEach(async () => { box = await sandbox(); });
afterEach(async () => { await box.cleanup(); });

describe("3 — the settings path rejects blocked tlds with a 400 and a specific reason", () => {
  for (const tld of ["local", "dev", "app", "page", "zip", "localhost"]) {
    test(`PATCH tld="${tld}" -> 400 carrying blockedTldReason verbatim`, async () => {
      await seed(BASE);
      const { PATCH } = await import("../app/api/settings/route.ts");
      const res = await PATCH(settingsReq({ tld }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: Array<{ field: string; message: string }> };
      const reason = blockedTldReason(tld);
      expect(reason).toBeTruthy();
      expect(body.issues).toEqual([{ field: "tld", message: reason! }]);
      expect((await loadConfig()).tld).toBe("test");
    });
  }

  test("the three reasons are three different sentences, each naming its own cause", async () => {
    const local = blockedTldReason("local")!;
    const dev = blockedTldReason("dev")!;
    const lh = blockedTldReason("localhost")!;
    expect(new Set([local, dev, lh]).size).toBe(3);
    expect(local).toMatch(/mDNS/); expect(local).toMatch(/5 seconds/);
    expect(dev).toMatch(/HSTS/); expect(dev).toMatch(/https:\/\//); expect(dev).not.toMatch(/mDNS/);
    expect(lh).toMatch(/127\.0\.0\.1/); expect(lh).toMatch(/\/etc\/hosts/);
  });

  test("every HSTS-preloaded TLD is refused through the real endpoint", async () => {
    await seed(BASE);
    const { PATCH } = await import("../app/api/settings/route.ts");
    for (const tld of HSTS_PRELOADED_TLDS) {
      const res = await PATCH(settingsReq({ tld }));
      expect(res.status).toBe(400);
    }
    expect((await loadConfig()).tld).toBe("test");
  });

  test("multi-label smuggling and case/padding tricks are all caught", async () => {
    await seed(BASE);
    const { PATCH } = await import("../app/api/settings/route.ts");
    for (const tld of ["my.local", "team.dev", "x.localhost", "a.b.local", "LOCAL", " local ", "Local", "DEV", "Localhost"]) {
      expect((await PATCH(settingsReq({ tld }))).status).toBe(400);
    }
    expect((await loadConfig()).tld).toBe("test");
  });

  for (const tld of ["test", "internal", "lan", "home.arpa", "example"]) {
    test(`PATCH tld="${tld}" -> 200 and it persists`, async () => {
      await seed(BASE);
      const { PATCH } = await import("../app/api/settings/route.ts");
      const res = await PATCH(settingsReq({ tld }));
      expect(res.status).toBe(200);
      expect((await loadConfig()).tld).toBe(tld);
    });
  }
});

describe("3b — no other code path can smuggle a blocked tld in", () => {
  test("alias creation ignores a tld field entirely", async () => {
    await seed(BASE);
    const { POST } = await import("../app/api/aliases/route.ts");
    const res = await POST(new Request("http://127.0.0.1:3000/api/aliases", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smuggle", port: 4000, tld: "local" }),
    }));
    expect(res.status).toBe(201);
    const after = await loadConfig();
    expect(after.tld).toBe("test");
    expect(JSON.stringify(after)).not.toMatch(/"local"/);
  });

  test("core updateSettings throws directly, so no caller can bypass the HTTP layer", async () => {
    await seed(BASE);
    for (const tld of ["local", "dev", "localhost"]) {
      let threw: unknown = null;
      try { await updateSettings({ tld }); } catch (e) { threw = e; }
      expect(threw).toBeInstanceOf(ValidationError);
      expect((threw as InstanceType<typeof ValidationError>).issues)
        .toEqual([{ field: "tld", message: blockedTldReason(tld)! }]);
    }
    expect((await loadConfig()).tld).toBe("test");
  });

  test("a hand-edited config.json naming a blocked tld never survives a load", async () => {
    for (const tld of ["local", "dev", "localhost", "my.local", "LOCAL", "zip"]) {
      await seed({ ...BASE, tld });
      const { value } = await quiet(() => loadConfig());
      expect(value.tld).toBe(DEFAULT_TLD);
    }
  });
});

describe("4 — coercion of a real .local config, and NO prompt on load", () => {
  /**
   * Kevin's own live layout, plus a deliberate GAP (no .5) and an out-of-order high IP.
   * Dense re-allocation would silently "pass" a contiguous fixture; it cannot pass this one.
   */
  const ALIASES = [
    { id: "a1", name: "index",   port: 3000, ip: "127.0.0.2",  enabled: true,  reserved: true,  projectPath: null, description: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "a2", name: "nareli",  port: 5173, ip: "127.0.0.3",  enabled: true,  reserved: false, projectPath: null, description: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "a3", name: "toto",    port: 8080, ip: "127.0.0.4",  enabled: false, reserved: false, projectPath: null, description: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "a4", name: "narelii", port: 4321, ip: "127.0.0.9",  enabled: true,  reserved: false, projectPath: null, description: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "a5", name: "shop",    port: 4000, ip: "127.0.0.30", enabled: true,  reserved: false, projectPath: "/Users/kevin/x", description: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];

  test("loads as .test, warns exactly once, and keeps every name/port/IP/enabled flag", async () => {
    await seed({ ...BASE, tld: "local", aliases: ALIASES });
    const { value: config, warnings } = await quiet(() => loadConfig());
    expect(config.tld).toBe("test");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/no longer supported/);
    expect(config.aliases.map((a) => [a.id, a.name, a.port, a.ip, a.enabled, a.projectPath]))
      .toEqual(ALIASES.map((a) => [a.id, a.name, a.port, a.ip, a.enabled, a.projectPath]));
  });

  test("buildDesiredState emits .test hostnames against the SAME loopback IPs", async () => {
    await seed({ ...BASE, tld: "local", aliases: ALIASES });
    const { value: config } = await quiet(() => loadConfig());
    const desired = buildDesiredState(config);
    const pairs = desired.hosts.map((h) => `${h.ip} ${h.hostname}`);
    for (const p of pairs) expect(p).not.toMatch(/\.local\b/);
    expect(pairs).toContain("127.0.0.2 index.test");
    expect(pairs).toContain("127.0.0.3 nareli.test");
    expect(pairs).toContain("127.0.0.9 narelii.test");
    expect(pairs).toContain("127.0.0.30 shop.test");
    // the gap survived: nothing was re-densified onto .5
    expect(pairs.some((p) => p.startsWith("127.0.0.5 "))).toBe(false);
    expect(desired.loopbackIps).toEqual(expect.arrayContaining(["127.0.0.2", "127.0.0.9", "127.0.0.30"]));
  });

  test("the repaired file on disk no longer says local", async () => {
    await seed({ ...BASE, tld: "local", aliases: ALIASES });
    await quiet(() => loadConfig());
    const onDisk = JSON.parse(await readFile(join(box.configDir, "config.json"), "utf8"));
    expect(onDisk.tld).toBe("test");
    expect(onDisk.aliases.length).toBe(5);
    expect(onDisk.aliases.map((a: { ip: string }) => a.ip)).toEqual(ALIASES.map((a) => a.ip));
  });

  test("merely LOADING queues no privileged request — the worst bug is an unsolicited prompt", async () => {
    await seed({ ...BASE, tld: "local", aliases: ALIASES });
    const before = await filesIn();
    await quiet(async () => { await loadConfig(); await loadConfig(); return 0; });
    const after = await filesIn();
    expect(after.filter((f) => /request/i.test(f))).toEqual([]);
    expect(after).toEqual(before);
  });

  test("a startup (userInitiated:false) sync never notifies the scheduler and writes no request", async () => {
    await seed({ ...BASE, tld: "local", aliases: ALIASES });
    const { updateSettingsAndSync } = await import("../lib/service.ts");
    const calls: string[] = [];
    const scheduler = {
      setEnabled: () => { calls.push("setEnabled"); },
      snapshot: () => ({ state: "idle", pending: false }),
      status: async () => ({ state: "idle", pending: false }),
      notifyMutation: async () => { calls.push("notifyMutation"); return { state: "idle", pending: false }; },
    } as never;
    await quiet(() => updateSettingsAndSync(
      { dashboardPort: 3001 },
      { userInitiated: false, scheduler, probes: stubProbes(), probeStatuses: false },
    ));
    expect(calls).not.toContain("notifyMutation");
    expect((await filesIn()).filter((f) => /request/i.test(f))).toEqual([]);
  });
});
