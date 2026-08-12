/**
 * Regression tests for helper drift recovery.
 *
 * The bug these exist for: the helper restarts under a running dashboard, comes
 * back with an empty route table, and nothing ever tells it about the aliases
 * again — `/etc/hosts` keeps resolving every name, so every site turns into the
 * branded 404 page until the user happens to edit something.
 *
 * They run against a real unix-socket helper stub (`Bun.serve({ unix })`) speaking
 * the real control protocol, so the whole path is exercised: `getStatus()` ->
 * drift comparison -> `helperApply` over the socket.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyRequest, HelperStatus, Route } from "@localhost-aliases/core";
import { loadConfig } from "@localhost-aliases/core";
import { createAliasFlow, getStatus } from "../lib/service.ts";
import {
  describeDrift,
  hasDrifted,
  observedFingerprint,
  resetReconcileState,
} from "../lib/reconcile.ts";

/** Nothing sane listens here, so probes resolve instantly as "down". */
const UPSTREAM_PORT = 59331;

// ---------------------------------------------------------------------------
// Helper stub — the real control protocol, none of the privileges
// ---------------------------------------------------------------------------

class HelperStub {
  routes: Route[] = [];
  managedHosts: string[] = [];
  httpPort = 80;
  httpsPort = 443;
  tls = false;
  applies = 0;
  /** When set, /apply answers an error — the "apply keeps failing" case. */
  rejectApplies = false;

  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(readonly socketPath: string) {}

  start(): void {
    this.server = Bun.serve({
      unix: this.socketPath,
      fetch: async (req) => {
        const { pathname } = new URL(req.url);
        if (req.method === "GET" && pathname === "/status") {
          return Response.json(this.status());
        }
        if (req.method === "POST" && pathname === "/apply") {
          this.applies += 1;
          if (this.rejectApplies) {
            return Response.json({ ok: false, error: "port 80 is already in use" }, { status: 400 });
          }
          const request = (await req.json()) as ApplyRequest;
          this.routes = request.routes;
          this.managedHosts = [...new Set(request.routes.map((r) => r.host))].sort();
          this.httpPort = request.httpPort;
          this.httpsPort = request.httpsPort;
          this.tls = request.tls !== null;
          return Response.json({ ok: true, hostsChanged: true, dnsFlushed: true, routes: this.routes.length });
        }
        return Response.json({ ok: false, error: "no route" }, { status: 404 });
      },
    });
  }

  /**
   * What a restart looks like from the outside: the process is new, so the route
   * table is empty and the ports fall back to defaults — but `/etc/hosts` still
   * holds the managed block, so `managedHosts` is untouched. That asymmetry is
   * the whole reason the check cannot be "compare hostnames" alone.
   */
  restart(): void {
    this.routes = [];
    this.httpPort = 80;
    this.httpsPort = 443;
    this.tls = false;
  }

  status(): HelperStatus {
    return {
      ok: true,
      version: "stub",
      uptime: 1,
      http: { listening: true, port: this.httpPort },
      https: { listening: this.tls, port: this.httpsPort },
      routes: this.routes.length,
      managedHosts: this.managedHosts,
    };
  }

  stop(): void {
    this.server?.stop(true);
  }
}

let root: string;
let helper: HelperStub;
let socketPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "la-reconcile-"));
  // Deliberately NOT under the temp root: a unix socket path over ~100 bytes
  // fails to bind with ENAMETOOLONG, and macOS temp dirs are already long.
  socketPath = `/tmp/la-rc-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;

  process.env.LA_CONFIG_DIR = join(root, "config");
  process.env.LA_SOCKET_PATH = socketPath;
  process.env.LA_HOSTS_PATH = join(root, "hosts");
  process.env.LA_CLAUDE_CONFIG = join(root, "claude.json");
  process.env.LA_CODEX_CONFIG = join(root, "codex", "config.toml");

  resetReconcileState();
  helper = new HelperStub(socketPath);
  helper.start();
});

afterEach(async () => {
  helper.stop();
  await rm(socketPath, { force: true });
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("drift detection", () => {
  test("an empty route table under a populated hosts block is drift", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const config = await loadConfig();

    expect(hasDrifted(config, helper.status())).toBe(false);

    helper.restart();
    expect(hasDrifted(config, helper.status())).toBe(true);
  });

  test("a changed listener port is drift even when the routes match", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const config = await loadConfig();

    const rebound = { ...helper.status(), http: { listening: true, port: 8080 } };
    expect(hasDrifted(config, rebound)).toBe(true);
  });

  test("hostname order is not drift", () => {
    const status = { ...helper.status(), managedHosts: ["b.local", "a.local"] };
    const sorted = { ...status, managedHosts: ["a.local", "b.local"] };
    expect(observedFingerprint(status)).toBe(observedFingerprint(sorted));
  });
});

describe("recovery", () => {
  test("a helper that lost its routes is repaired by the next status poll", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    expect(helper.routes.map((route) => route.host)).toEqual(["shop.local"]);

    helper.restart();
    expect(helper.status().routes).toBe(0);

    // No mutation, no UI interaction — just the poll the status strip already does.
    const payload = await getStatus();

    expect(helper.routes.map((route) => route.host)).toEqual(["shop.local"]);
    // And the response reports the state it restored, not the one it diagnosed.
    expect(payload.helper.status?.routes).toBe(1);
  });

  test("a healthy helper is never re-applied", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const after = helper.applies;

    await getStatus();
    await getStatus();
    await getStatus();

    expect(helper.applies).toBe(after);
  });

  test("one repair, not one per poll", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const before = helper.applies;

    helper.restart();
    await getStatus();
    await getStatus();
    await getStatus();

    expect(helper.applies).toBe(before + 1);
  });

  test("an apply that keeps failing is backed off, not hammered", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const before = helper.applies;

    helper.restart();
    helper.rejectApplies = true;

    for (let i = 0; i < 5; i += 1) await getStatus();

    // One attempt, then the backoff window (5s) swallows the rest of this test.
    expect(helper.applies).toBe(before + 1);
  });

  test("an unreachable helper is not treated as drift", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const before = helper.applies;

    helper.stop();
    await rm(socketPath, { force: true });

    const payload = await getStatus();

    expect(payload.helper.running).toBe(false);
    expect(payload.helper.status).toBeNull();
    expect(helper.applies).toBe(before);

    helper = new HelperStub(socketPath); // afterEach needs something to stop
  });
});

// ---------------------------------------------------------------------------

/** Captures console.log for the duration of `run`, so log-shape claims are testable. */
async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("the drift log line", () => {
  test("names what actually diverged, not just the route count", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const config = await loadConfig();

    // Same number of routes, different hostname and a different listener port:
    // the count-only phrasing used to render this as "has 1 route(s), wants 1".
    const status = helper.status();
    status.managedHosts = ["stale.local"];
    status.http.port = config.httpPort + 1;

    const described = describeDrift(config, status);

    expect(described).not.toContain("route");
    expect(described).toContain("stale.local");
    expect(described).toContain("shop.local");
    expect(described).toContain(`http port ${config.httpPort + 1} -> ${config.httpPort}`);
  });

  test("reports a lost route table as a route-count change", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const config = await loadConfig();

    helper.restart(); // routes dropped, managed hosts survive in the hosts file

    expect(describeDrift(config, helper.status())).toContain("routes 0 -> 1");
  });

  test("a helper stuck out of sync logs the wait once, not once per poll", async () => {
    await createAliasFlow({ name: "shop", port: UPSTREAM_PORT });
    const before = helper.applies;

    helper.restart();
    helper.rejectApplies = true;

    const lines = await captureLogs(async () => {
      for (let i = 0; i < 6; i += 1) await getStatus();
    });

    // One attempt, then every later poll lands inside the 5s backoff window. That
    // window must produce exactly one line however many times it is polled --
    // a countdown baked into the text used to defeat the deduplication entirely.
    const waiting = lines.filter((line) => line.includes("still out of sync"));
    expect(waiting.length).toBe(1);
    expect(waiting[0]).not.toMatch(/\d+s/);
    expect(helper.applies).toBe(before + 1);
  });
});
