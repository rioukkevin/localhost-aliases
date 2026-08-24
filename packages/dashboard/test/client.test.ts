/**
 * Unit tests for the dashboard's client logic — the parts that decide what the user is
 * told and what survives a failed request. No DOM, no browser: the components are not
 * rendered here, only the pure functions and the shared store they read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AliasView } from "@localhost-aliases/core/types";
import { countLabel, folderName, isPending, pendingAlias, tildePath } from "../lib/client/format.ts";
import {
  isAbsolutePath,
  validateAliasForm,
  validateDashboardPort,
  validateName,
  validatePort,
  validateTld,
} from "../lib/client/validate.ts";
import {
  mutateAliases,
  refreshStatus,
  resetStatus,
  snapshot,
} from "../lib/client/status-store.ts";

function alias(partial: Partial<AliasView> & { name: string; port: number }): AliasView {
  return {
    id: partial.id ?? partial.name,
    name: partial.name,
    port: partial.port,
    ip: partial.ip ?? "127.0.0.2",
    projectPath: partial.projectPath ?? null,
    description: null,
    enabled: true,
    reserved: partial.reserved ?? false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hostname: `${partial.name}.test`,
    url: `http://${partial.name}.test`,
    status: partial.status ?? "unknown",
  };
}

const ctx = (aliases: AliasView[] = []) => ({ aliases, tld: "test" });

describe("alias name validation", () => {
  test("accepts a plain label and a dotted one", () => {
    expect(validateName("myapp", ctx())).toBeNull();
    expect(validateName("api.myapp", ctx())).toBeNull();
  });

  test("rejects the shapes the store would reject", () => {
    expect(validateName("", ctx())).toMatch(/required/);
    expect(validateName("MyApp", ctx())).toMatch(/lowercase/);
    expect(validateName("my_app", ctx())).toMatch(/letters, digits and hyphens/);
    expect(validateName("-myapp", ctx())).toMatch(/hyphen/);
    expect(validateName("my..app", ctx())).toMatch(/Dots must separate/);
    expect(validateName("a".repeat(64), ctx())).toMatch(/64|63/);
  });

  test("rejects reserved names, including the dashboard's own", () => {
    expect(validateName("localhost", ctx())).toMatch(/reserved by macOS/);
    expect(validateName("index", ctx())).toMatch(/reserved for the dashboard/);
  });

  test("rejects a duplicate but allows the alias being edited to keep its name", () => {
    const existing = [alias({ name: "myapp", port: 3000 })];
    expect(validateName("myapp", ctx(existing))).toMatch(/already exists/);
    expect(validateName("myapp", { ...ctx(existing), excludeId: "myapp" })).toBeNull();
  });
});

describe("port validation", () => {
  test("range and shape", () => {
    expect(validatePort("3000")).toBeNull();
    expect(validatePort("")).toMatch(/required/);
    expect(validatePort("80.5")).toMatch(/whole number/);
    expect(validatePort("0")).toMatch(/whole number/);
    expect(validatePort("65536")).toMatch(/whole number/);
  });

  test("a port another alias already uses is a warning, not an error", () => {
    const existing = [alias({ name: "myapp", port: 3000 })];
    const issues = validateAliasForm({ name: "other", port: "3000" }, ctx(existing));
    expect(issues.port).toBeNull();
    expect(issues.portWarning).toMatch(/myapp\.test already forwards/);
  });

  test("the dashboard's own port must stay unprivileged", () => {
    expect(validateDashboardPort("7788")).toBeNull();
    expect(validateDashboardPort("80")).toMatch(/above 1024/);
  });
});

describe("tld and path helpers", () => {
  test("tld rules", () => {
    expect(validateTld("test")).toBeNull();
    expect(validateTld(".test")).toMatch(/leading dot/);
    expect(validateTld("TEST")).toMatch(/lowercase/);
  });

  test("absolute paths only", () => {
    expect(isAbsolutePath("/Users/kevin/code")).toBe(true);
    expect(isAbsolutePath("code")).toBe(false);
    expect(isAbsolutePath("/Users//kevin")).toBe(false);
  });

  test("home is abbreviated to a tilde", () => {
    expect(tildePath("/Users/kevin/code/app")).toBe("~/code/app");
    expect(tildePath("/Users/kevin")).toBe("~");
    expect(tildePath("/opt/thing")).toBe("/opt/thing");
    expect(folderName("/Users/kevin/code/app")).toBe("app");
  });

  test("counts read as English", () => {
    expect(countLabel(1, "alias", "aliases")).toBe("1 alias");
    expect(countLabel(2, "alias", "aliases")).toBe("2 aliases");
  });
});

describe("the optimistic row", () => {
  test("is marked pending and carries the hostname the server will produce", () => {
    const row = pendingAlias({ name: "myapp", port: 3000 }, "test");
    expect(isPending(row)).toBe(true);
    expect(row.hostname).toBe("myapp.test");
    expect(row.url).toBe("http://myapp.test");
    expect(row.status).toBe("unknown");
  });
});

// --- the shared store -------------------------------------------------------

const payload = {
  config: { version: 2, tld: "test", dashboardPort: 7788, https: false, aliases: [] },
  aliases: [alias({ name: "myapp", port: 3000 })],
  system: { loopbackIps: [], managedHosts: [], forwarder: null, applied: false, drift: [] },
  sync: { applied: false, needsPrompt: true, drift: [], privileged: [], unprivileged: [], intent: {} },
};

function stubFetch(handler: (path: string, init?: RequestInit) => Response): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetStatus();
});

describe("status store", () => {
  test("a good read fills the snapshot", async () => {
    stubFetch(() => Response.json(payload));
    await refreshStatus();
    expect(snapshot().loaded).toBe(true);
    expect(snapshot().reachable).toBe(true);
    expect(snapshot().aliases).toHaveLength(1);
    expect(snapshot().sync?.needsPrompt).toBe(true);
  });

  test("a failed read keeps the last good data and only flips reachable", async () => {
    stubFetch(() => Response.json(payload));
    await refreshStatus();
    stubFetch(() => new Response("nope", { status: 500 }));
    await refreshStatus();
    expect(snapshot().reachable).toBe(false);
    expect(snapshot().aliases).toHaveLength(1); // dims rather than empties
    expect(snapshot().error).not.toBeNull();
  });

  test("concurrent refreshes are single-flighted", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return Response.json(payload);
    });
    await Promise.all([refreshStatus(), refreshStatus(), refreshStatus()]);
    expect(calls).toBe(1);
  });

  test("an optimistic mutation is rolled back when the request fails", async () => {
    stubFetch(() => Response.json(payload));
    await refreshStatus();
    const before = snapshot().aliases;

    await expect(
      mutateAliases(
        (list) => [...list, pendingAlias({ name: "second", port: 4000 }, "local")],
        async () => {
          expect(snapshot().aliases).toHaveLength(2); // shown while in flight
          throw new Error("rejected");
        },
      ),
    ).rejects.toThrow("rejected");

    expect(snapshot().aliases).toEqual(before);
    expect(snapshot().busy).toBe(false);
  });

  test("a successful mutation reconciles with a fresh read", async () => {
    stubFetch(() => Response.json(payload));
    await refreshStatus();
    const result = await mutateAliases(
      (list) => list.filter((a) => a.name !== "myapp"),
      async () => "done",
    );
    expect(result).toBe("done");
    expect(snapshot().aliases).toHaveLength(1); // server is the truth again
  });
});
