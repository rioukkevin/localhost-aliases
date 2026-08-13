import { describe, expect, test } from "bun:test";
import { buildDesiredState, diffDesiredState, LISTEN_PORT, targetPortFor } from "../src/desired-state.ts";
import type { Alias, Config, ForwarderStatus, Route, SystemState } from "../src/types.ts";

function alias(partial: Partial<Alias> & Pick<Alias, "name" | "port" | "ip">): Alias {
  return {
    id: partial.name,
    projectPath: null,
    description: null,
    enabled: true,
    reserved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const CONFIG: Config = {
  version: 2,
  tld: "local",
  dashboardPort: 7788,
  https: false,
  aliases: [
    alias({ name: "index", port: 7788, ip: "127.0.0.2", reserved: true }),
    alias({ name: "myapp", port: 3000, ip: "127.0.0.3" }),
  ],
};

function live(partial: Partial<SystemState> = {}): SystemState {
  const desired = buildDesiredState(CONFIG);
  return {
    loopbackIps: ["127.0.0.1", ...desired.loopbackIps],
    managedHosts: desired.hosts.map((h) => h.hostname),
    forwarder: forwarder(desired.routes),
    applied: true,
    drift: [],
    ...partial,
  };
}

function forwarder(routes: Route[], failures: ForwarderStatus["failures"] = []): ForwarderStatus {
  return { pid: 1234, startedAt: "2026-01-01T00:00:00.000Z", routes, failures };
}

describe("buildDesiredState", () => {
  test("maps enabled aliases to hosts, IPs and routes", () => {
    const desired = buildDesiredState(CONFIG);
    expect(desired.hosts).toEqual([
      { ip: "127.0.0.2", hostname: "index.local" },
      { ip: "127.0.0.3", hostname: "myapp.local" },
    ]);
    expect(desired.loopbackIps).toEqual(["127.0.0.2", "127.0.0.3"]);
    expect(desired.routes).toEqual([
      { ip: "127.0.0.2", listenPort: LISTEN_PORT, targetPort: 7788, hostname: "index.local" },
      { ip: "127.0.0.3", listenPort: LISTEN_PORT, targetPort: 3000, hostname: "myapp.local" },
    ]);
  });

  test("the reserved alias targets dashboardPort, not its stored port", () => {
    const config: Config = {
      ...CONFIG,
      dashboardPort: 9100,
      aliases: [alias({ name: "index", port: 1, ip: "127.0.0.2", reserved: true })],
    };
    expect(buildDesiredState(config).routes[0]!.targetPort).toBe(9100);
    expect(targetPortFor(config.aliases[0]!, config)).toBe(9100);
  });

  test("disabled aliases are excluded entirely", () => {
    const config: Config = {
      ...CONFIG,
      aliases: [...CONFIG.aliases, alias({ name: "off", port: 4000, ip: "127.0.0.4", enabled: false })],
    };
    const desired = buildDesiredState(config);
    expect(desired.loopbackIps).not.toContain("127.0.0.4");
    expect(desired.routes.map((r) => r.hostname)).not.toContain("off.local");
  });

  test("the configured TLD is used", () => {
    expect(buildDesiredState({ ...CONFIG, tld: "test" }).hosts[0]!.hostname).toBe("index.test");
  });

  test("listen port is 80 for every route", () => {
    expect(buildDesiredState(CONFIG).routes.every((r) => r.listenPort === 80)).toBe(true);
  });

  test("an empty config yields empty state", () => {
    const desired = buildDesiredState({ ...CONFIG, aliases: [] });
    expect(desired).toEqual({ hosts: [], loopbackIps: [], routes: [] });
  });
});

describe("diffDesiredState — no prompt", () => {
  test("fully applied state is clean", () => {
    const diff = diffDesiredState(buildDesiredState(CONFIG), live());
    expect(diff.applied).toBe(true);
    expect(diff.needsPrompt).toBe(false);
    expect(diff.drift).toEqual([]);
  });

  test("A PORT-ONLY CHANGE NEVER PROMPTS", () => {
    const desired = buildDesiredState({
      ...CONFIG,
      aliases: [CONFIG.aliases[0]!, alias({ name: "myapp", port: 3001, ip: "127.0.0.3" })],
    });
    const diff = diffDesiredState(desired, live());

    expect(diff.needsPrompt).toBe(false);
    expect(diff.privileged).toEqual([]);
    expect(diff.applied).toBe(false);
    expect(diff.unprivileged).toHaveLength(1);
    expect(diff.unprivileged[0]).toContain("myapp.local");
    expect(diff.unprivileged[0]).toContain("3001");
    expect(diff.unprivileged[0]).toContain("reloads");
  });

  test("changing the dashboard port alone never prompts", () => {
    const desired = buildDesiredState({ ...CONFIG, dashboardPort: 9100 });
    const diff = diffDesiredState(desired, live());
    expect(diff.needsPrompt).toBe(false);
    expect(diff.unprivileged[0]).toContain("index.local");
  });

  test("a route the forwarder still holds but no longer needs does not prompt", () => {
    const desired = buildDesiredState(CONFIG);
    const stale: Route = { ip: "127.0.0.9", listenPort: 80, targetPort: 5000, hostname: "gone.local" };
    // the lo0 address is already gone, so only the forwarder is behind
    const diff = diffDesiredState(desired, live({ forwarder: forwarder([...desired.routes, stale]) }));
    expect(diff.needsPrompt).toBe(false);
    expect(diff.unprivileged[0]).toContain("gone.local");
  });

  test("unmanaged loopback addresses outside the pool are ignored", () => {
    const diff = diffDesiredState(
      buildDesiredState(CONFIG),
      live({ loopbackIps: ["127.0.0.1", "127.0.1.5", "127.0.0.2", "127.0.0.3"] }),
    );
    expect(diff.applied).toBe(true);
  });
});

describe("diffDesiredState — prompt required", () => {
  test("a missing lo0 address prompts (the reboot case)", () => {
    const diff = diffDesiredState(buildDesiredState(CONFIG), live({ loopbackIps: ["127.0.0.1"] }));
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("127.0.0.2");
    expect(diff.privileged.join(" ")).toContain("lo0");
  });

  test("a stale pool address prompts", () => {
    const diff = diffDesiredState(
      buildDesiredState(CONFIG),
      live({ loopbackIps: ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4"] }),
    );
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("Stale");
  });

  test("a new alias prompts", () => {
    const desired = buildDesiredState({
      ...CONFIG,
      aliases: [...CONFIG.aliases, alias({ name: "fresh", port: 4000, ip: "127.0.0.4" })],
    });
    const diff = diffDesiredState(desired, live());
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("fresh.local");
  });

  test("a rename prompts", () => {
    const desired = buildDesiredState({
      ...CONFIG,
      aliases: [CONFIG.aliases[0]!, alias({ name: "renamed", port: 3000, ip: "127.0.0.3" })],
    });
    const diff = diffDesiredState(desired, live());
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("/etc/hosts");
  });

  test("a changed TLD prompts", () => {
    const diff = diffDesiredState(buildDesiredState({ ...CONFIG, tld: "test" }), live());
    expect(diff.needsPrompt).toBe(true);
  });

  test("a leftover /etc/hosts entry prompts", () => {
    const diff = diffDesiredState(
      buildDesiredState(CONFIG),
      live({ managedHosts: ["index.local", "myapp.local", "old.local"] }),
    );
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("old.local");
  });

  test("a stopped forwarder prompts", () => {
    const diff = diffDesiredState(buildDesiredState(CONFIG), live({ forwarder: null }));
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged).toContain("The forwarder is not running.");
  });

  test("no forwarder and nothing desired is still clean", () => {
    const diff = diffDesiredState(buildDesiredState({ ...CONFIG, aliases: [] }), {
      loopbackIps: ["127.0.0.1"],
      managedHosts: [],
      forwarder: null,
      applied: true,
      drift: [],
    });
    expect(diff.applied).toBe(true);
  });

  test("a hostname bound to the wrong IP prompts", () => {
    const desired = buildDesiredState(CONFIG);
    const wrong = desired.routes.map((r) =>
      r.hostname === "myapp.local" ? { ...r, ip: "127.0.0.7" } : r,
    );
    const diff = diffDesiredState(desired, live({ forwarder: forwarder(wrong) }));
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("expected 127.0.0.3:80");
  });

  test("a bind failure prompts", () => {
    const desired = buildDesiredState(CONFIG);
    const diff = diffDesiredState(
      desired,
      live({ forwarder: forwarder(desired.routes, [{ route: desired.routes[1]!, error: "EADDRINUSE" }]) }),
    );
    expect(diff.needsPrompt).toBe(true);
    expect(diff.privileged.join(" ")).toContain("EADDRINUSE");
  });

  test("unread system state counts as drift", () => {
    const diff = diffDesiredState(buildDesiredState(CONFIG), null);
    expect(diff.needsPrompt).toBe(true);
  });

  test("unread system state with nothing desired is clean", () => {
    expect(diffDesiredState({ hosts: [], loopbackIps: [], routes: [] }, null).applied).toBe(true);
  });

  test("drift lists privileged reasons first", () => {
    const desired = buildDesiredState({
      ...CONFIG,
      aliases: [CONFIG.aliases[0]!, alias({ name: "myapp", port: 3001, ip: "127.0.0.3" })],
    });
    const diff = diffDesiredState(desired, live({ managedHosts: ["index.local"] }));
    expect(diff.drift).toEqual([...diff.privileged, ...diff.unprivileged]);
    expect(diff.privileged).toHaveLength(1);
    expect(diff.unprivileged).toHaveLength(1);
    expect(diff.needsPrompt).toBe(true);
  });
});
