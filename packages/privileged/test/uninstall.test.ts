import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTS_BEGIN, HOSTS_END } from "@localhost-aliases/core/types";
import { APPLY, STATE_TWO, SYSTEM_HOSTS, UNINSTALL, killSandboxProcesses, makeSandbox, run, type Sandbox } from "./helpers.ts";

const sandboxes: Sandbox[] = [];
function sandbox(): Sandbox {
  const s = makeSandbox();
  sandboxes.push(s);
  return s;
}
afterEach(() => {
  while (sandboxes.length > 0) killSandboxProcesses(sandboxes.pop()!);
});

const apply = (s: Sandbox, args: string[]) => run(["/bin/bash", APPLY, ...args], s.env());
const uninstall = (s: Sandbox, extra: Record<string, string> = {}) =>
  run(["/bin/bash", UNINSTALL], s.env(extra));

describe("uninstall.sh", () => {
  test("undoes a full apply and leaves the rest of the file untouched", async () => {
    const s = sandbox();
    const applied = await apply(s, [s.writeState(STATE_TWO)]);
    expect(applied.summary.status).toBe("ok");

    const r = await uninstall(s);
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({
      status: "ok",
      ips_removed: "2",
      hosts: "changed",
      dns: "flushed",
      forwarder: "stopped",
    });
    expect(s.hosts()).toBe(SYSTEM_HOSTS);
    expect(s.lo0()).toEqual(["127.0.0.1"]);
    expect(s.calls("killall")).toContain("-HUP mDNSResponder");
    expect(existsSync(join(s.configDir, "forwarder-status.json"))).toBe(false);

    const pid = Number(applied.summary.pid);
    await Bun.sleep(50);
    expect(isAlive(pid)).toBe(false);
  });

  test("drops the liveness file so the forwarder exits even if it is not signalled", async () => {
    const s = sandbox();
    const liveness = join(s.configDir, "liveness");
    writeFileSync(liveness, "");
    const env = s.env();
    delete (env as Record<string, string | undefined>).LA_FORWARDER;
    const r = await run(["/bin/bash", UNINSTALL], env as Record<string, string>);
    expect(r.code).toBe(0);
    expect(r.summary.forwarder).toBe("unverified");
    expect(existsSync(liveness)).toBe(false);
  });

  test("is idempotent", async () => {
    const s = sandbox();
    await apply(s, [s.writeState(STATE_TWO)]);
    await uninstall(s);
    const second = await uninstall(s);
    expect(second.code).toBe(0);
    expect(second.summary).toMatchObject({ ips_removed: "0", hosts: "unchanged", forwarder: "not-running" });
    expect(s.hosts()).toBe(SYSTEM_HOSTS);
  });

  test("works on a machine that was never applied to", async () => {
    const s = sandbox();
    const r = await uninstall(s);
    expect(r.code).toBe(0);
    expect(s.hosts()).toBe(SYSTEM_HOSTS);
    expect(s.lo0()).toEqual(["127.0.0.1"]);
  });

  test("never removes 127.0.0.1 or an address outside the pool", async () => {
    const s = sandbox();
    s.setLo0(["127.0.0.1", "127.0.0.2", "192.168.1.10"]);
    await uninstall(s);
    expect(s.lo0()).toEqual(["127.0.0.1", "192.168.1.10"]);
    expect(s.calls("ifconfig")).toContain("lo0 -alias 127.0.0.2");
  });

  test("LA_MANAGED_IPS keeps pool addresses we did not allocate", async () => {
    const s = sandbox();
    s.setLo0(["127.0.0.1", "127.0.0.2", "127.0.0.50"]);
    await uninstall(s, { LA_MANAGED_IPS: "127.0.0.2" });
    expect(s.lo0()).toEqual(["127.0.0.1", "127.0.0.50"]);
  });

  test("keeps hand-written lines and only strips the markers", async () => {
    const s = sandbox();
    const tail = "10.1.2.3\tstaging.internal\n";
    writeFileSync(s.hostsPath, `${SYSTEM_HOSTS}${HOSTS_BEGIN}\n127.0.0.2\ta.test\n${HOSTS_END}\n${tail}`);
    await uninstall(s);
    expect(s.hosts()).toBe(`${SYSTEM_HOSTS}${tail}`);
  });

  test("deletes nothing else in the config directory", async () => {
    const s = sandbox();
    const config = join(s.configDir, "config.json");
    writeFileSync(config, '{"version":2}');
    await apply(s, [s.writeState(STATE_TWO)]);
    await uninstall(s);
    expect(readFileSync(config, "utf8")).toBe('{"version":2}');
    expect(existsSync(join(s.configDir, "hosts.original"))).toBe(true);
  });

  test("takes no arguments", async () => {
    const s = sandbox();
    const r = await run(["/bin/bash", UNINSTALL, "--force"], s.env());
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("LA_RESULT status=error step=arguments");
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
