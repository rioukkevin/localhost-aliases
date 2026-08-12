import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { Alias, Config, HelperStatus } from "../src/types.ts";
import {
  HELPER_TIMEOUT_MS,
  buildApplyRequest,
  buildRoutes,
  helperApply,
  helperAvailability,
  helperSocketPath,
  helperStatus,
} from "../src/helper-client.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function alias(over: Partial<Alias> = {}): Alias {
  return {
    id: "a1",
    name: "api",
    port: 3000,
    target: "127.0.0.1",
    projectPath: null,
    description: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function config(aliases: Alias[], over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, aliases, ...over };
}

const STATUS: HelperStatus = {
  ok: true,
  version: "0.1.0",
  uptime: 12,
  http: { listening: true, port: 80 },
  https: { listening: false, port: 443 },
  routes: 1,
  managedHosts: ["api.local"],
};

// The socket lives in a short temp dir: sun_path is capped at ~104 bytes on macOS.
const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
let socketPath = "";
let savedSocketEnv: string | undefined;

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "la-h-"));
  dirs.push(dir);
  return join(dir, "h.sock");
}

/** Fake helper speaking the same protocol over a unix socket. */
function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ unix: socketPath, fetch: handler });
  servers.push(server);
  return server;
}

beforeEach(() => {
  savedSocketEnv = process.env.LA_SOCKET_PATH;
  socketPath = tempSocketPath();
  process.env.LA_SOCKET_PATH = socketPath;
});

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop(true);
  if (savedSocketEnv === undefined) delete process.env.LA_SOCKET_PATH;
  else process.env.LA_SOCKET_PATH = savedSocketEnv;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("helperSocketPath", () => {
  test("honours LA_SOCKET_PATH so tests never need /var/run", () => {
    expect(helperSocketPath()).toBe(socketPath);
    delete process.env.LA_SOCKET_PATH;
    expect(helperSocketPath()).toBe("/var/run/localhost-aliases.sock");
  });
});

describe("helperStatus", () => {
  test("returns the parsed status over the unix socket", async () => {
    serve(() => Response.json(STATUS));
    const result = await helperStatus();
    expect(result).toEqual({ ok: true, data: STATUS });
  });

  test("reports unreachable when nothing is listening", async () => {
    const result = await helperStatus();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unreachable");
    expect(result.error).toContain(socketPath);
  });

  test("reports an error when the helper answers with HTTP 500", async () => {
    serve(() => Response.json({ ok: false, error: "hosts file is read-only" }, { status: 500 }));
    const result = await helperStatus();
    expect(result).toEqual({ ok: false, code: "error", error: "hosts file is read-only" });
  });

  test("reports an error when the helper answers with a non-JSON body", async () => {
    serve(() => new Response("<html>nope</html>"));
    const result = await helperStatus();
    expect(result).toMatchObject({ ok: false, code: "error" });
  });

  test("reports an error on a JSON body carrying ok:false with HTTP 200", async () => {
    serve(() => Response.json({ ok: false, error: "boom" }));
    expect(await helperStatus()).toEqual({ ok: false, code: "error", error: "boom" });
  });

  test("times out instead of hanging, and never throws", async () => {
    serve(async () => {
      await Bun.sleep(HELPER_TIMEOUT_MS * 3);
      return Response.json(STATUS);
    });
    const started = Date.now();
    const result = await helperStatus();
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
    expect(Date.now() - started).toBeLessThan(HELPER_TIMEOUT_MS * 2);
  });
});

describe("helperApply", () => {
  test("POSTs the desired state as JSON and returns the response", async () => {
    let seen: unknown = null;
    serve(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/apply");
      seen = await req.json();
      return Response.json({ ok: true, hostsChanged: true, dnsFlushed: true, routes: 1 });
    });

    const request = buildApplyRequest(config([alias()]), null);
    const result = await helperApply(request);
    expect(result).toEqual({
      ok: true,
      data: { ok: true, hostsChanged: true, dnsFlushed: true, routes: 1 },
    });
    expect(seen).toEqual(request);
  });

  test("never throws when the helper is absent", async () => {
    const result = await helperApply(buildApplyRequest(config([]), null));
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
  });
});

describe("helperAvailability", () => {
  test("not installed when neither the socket nor the daemon plist exist", async () => {
    const result = await helperAvailability();
    expect(result.installed).toBe(false);
    expect(result.running).toBe(false);
    expect(result.reason).toContain("install");
  });

  test("installed and running when the helper answers", async () => {
    serve(() => Response.json(STATUS));
    expect(await helperAvailability()).toEqual({ installed: true, running: true, reason: null });
  });

  test("installed but not running when the socket file is stale", async () => {
    // A crashed helper leaves the socket file behind; only connecting reveals it.
    writeFileSync(socketPath, "");
    const result = await helperAvailability();
    expect(result.installed).toBe(true);
    expect(result.running).toBe(false);
    expect(result.reason).toContain("launchctl");
  });

  test("running with a reason when the helper answers with an error", async () => {
    serve(() => Response.json({ ok: false, error: "cannot bind :80" }, { status: 500 }));
    const result = await helperAvailability();
    expect(result).toEqual({
      installed: true,
      running: true,
      reason: "The helper is running but returned an error: cannot bind :80",
    });
  });

  test("never throws", async () => {
    process.env.LA_SOCKET_PATH = "/nope/definitely/missing.sock";
    expect(await helperAvailability()).toMatchObject({ installed: false, running: false });
  });
});

describe("buildRoutes", () => {
  test("maps enabled aliases to routes using hostnameFor", () => {
    const cfg = config(
      [
        alias({ id: "a1", name: "api", port: 3000 }),
        alias({ id: "a2", name: "web.myapp", port: 5173, target: "::1" }),
      ],
      { tld: "test" },
    );
    expect(buildRoutes(cfg)).toEqual([
      { host: "api.test", target: "127.0.0.1", port: 3000, aliasId: "a1" },
      { host: "web.myapp.test", target: "::1", port: 5173, aliasId: "a2" },
    ]);
  });

  test("skips disabled aliases", () => {
    const cfg = config([alias({ id: "a1" }), alias({ id: "a2", name: "off", enabled: false })]);
    expect(buildRoutes(cfg).map((r) => r.aliasId)).toEqual(["a1"]);
  });

  test("falls back to 127.0.0.1 when the target is empty", () => {
    expect(buildRoutes(config([alias({ target: "" })]))[0]?.target).toBe("127.0.0.1");
  });

  test("returns an empty list for an empty config", () => {
    expect(buildRoutes(config([]))).toEqual([]);
  });
});

describe("buildApplyRequest", () => {
  const tls = { cert: "CERT", key: "KEY" };

  test("carries ports, routes and TLS material when https is on", () => {
    const cfg = config([alias()], { https: true, httpPort: 8080, httpsPort: 8443 });
    expect(buildApplyRequest(cfg, tls)).toEqual({
      httpPort: 8080,
      httpsPort: 8443,
      routes: buildRoutes(cfg),
      tls,
    });
  });

  test("drops TLS material when https is off", () => {
    expect(buildApplyRequest(config([alias()]), tls).tls).toBeNull();
  });

  test("tolerates a null TLS pair while https is on", () => {
    expect(buildApplyRequest(config([], { https: true }), null).tls).toBeNull();
  });
});
