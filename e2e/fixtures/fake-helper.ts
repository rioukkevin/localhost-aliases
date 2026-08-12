/**
 * A stand-in for the privileged helper: same control protocol, no privileges.
 *
 * `packages/helper` needs root because it binds :80/:443, rewrites /etc/hosts and
 * flushes DNS. None of that is what the dashboard e2e suite is testing — the suite
 * only needs something on the other end of the unix socket that answers the same
 * three endpoints and reconciles a managed hosts block. So this process:
 *
 *   - serves GET /status, POST /apply and POST /shutdown over `Bun.serve({ unix })`
 *   - reconciles the managed block into a TEMP hosts file (`LA_HOSTS_PATH`) with
 *     core's real `applyBlock`, so the block format under test is the real one
 *   - journals every ApplyRequest it receives, so a test can assert exactly what
 *     the dashboard pushed
 *
 * and deliberately never binds a port, never flushes DNS, and never chowns
 * anything. Run it with Bun: `bun fixtures/fake-helper.ts`.
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import {
  applyBlock,
  isValidHostname,
  parseBlock,
  readHosts,
  writeHosts,
  type ApplyRequest,
  type ApplyResponse,
  type HelperError,
  type HelperStatus,
  type Route,
} from "@localhost-aliases/core";

const VERSION = "e2e-fake-helper";
const startedAt = Date.now();

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set — the fake helper never falls back to a system path`);
  }
  return value;
}

const socketPath = required("LA_SOCKET_PATH");
const journalPath = required("LA_HELPER_JOURNAL");
// Read for its side effect: core's hosts I/O reads it lazily, and a fake helper
// that could reach /etc/hosts is not a fake helper.
required("LA_HOSTS_PATH");

// ---------------------------------------------------------------------------
// State — the real helper is stateless between applies, and so is this one
// ---------------------------------------------------------------------------

let routes: Route[] = [];
let httpPort = Number(process.env.LA_HTTP_PORT ?? 80);
let httpsPort = Number(process.env.LA_HTTPS_PORT ?? 443);

/**
 * Sorted and deduped, exactly like `packages/helper/src/hosts-sync.ts`: the block
 * is a function of the set of aliases, not of their order in config.json.
 */
function managedHostnames(): string[] {
  return [...new Set(routes.map((route) => route.host.toLowerCase()))].sort();
}

// ---------------------------------------------------------------------------
// Journal — the suite's window into what the dashboard actually pushed
// ---------------------------------------------------------------------------

async function journal(request: ApplyRequest): Promise<void> {
  const file = Bun.file(journalPath);
  let entries: unknown[] = [];
  if (await file.exists()) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // A truncated journal is not worth failing an apply over; start a new one.
    }
  }
  entries.push({ at: new Date().toISOString(), request });
  await Bun.write(journalPath, `${JSON.stringify(entries, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function failure(message: string, status: number): Response {
  const body: HelperError = { ok: false, error: message };
  return json(body, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The same shape of gate the real helper applies. It matters here too: a test that
 * pushes a hostname the real daemon would refuse must fail, not quietly pass.
 */
function validate(body: unknown): { ok: true; value: ApplyRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  if (!validPort(body.httpPort)) return { ok: false, error: "httpPort must be an integer 1-65535" };
  if (!validPort(body.httpsPort)) return { ok: false, error: "httpsPort must be an integer 1-65535" };
  if (!Array.isArray(body.routes)) return { ok: false, error: "routes must be an array" };

  const parsed: Route[] = [];
  for (const [index, raw] of body.routes.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `routes[${index}] must be an object` };
    const host = typeof raw.host === "string" ? raw.host.trim().toLowerCase() : "";
    if (!isValidHostname(host)) {
      return { ok: false, error: `routes[${index}].host ${JSON.stringify(raw.host)} is not valid` };
    }
    if (!validPort(raw.port)) {
      return { ok: false, error: `routes[${index}].port must be an integer 1-65535` };
    }
    parsed.push({
      host,
      target: typeof raw.target === "string" ? raw.target : "127.0.0.1",
      port: raw.port,
      aliasId: typeof raw.aliasId === "string" ? raw.aliasId : "",
    });
  }

  const tlsBody = body.tls;
  return {
    ok: true,
    value: {
      httpPort: body.httpPort,
      httpsPort: body.httpsPort,
      routes: parsed,
      tls:
        isRecord(tlsBody) && typeof tlsBody.cert === "string" && typeof tlsBody.key === "string"
          ? { cert: tlsBody.cert, key: tlsBody.key }
          : null,
    },
  };
}

async function status(): Promise<HelperStatus> {
  return {
    ok: true,
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    // Nothing is bound: binding :80 is the one thing this process cannot do.
    http: { listening: false, port: httpPort },
    https: { listening: false, port: httpsPort },
    routes: routes.length,
    managedHosts: parseBlock(await readHosts()),
  };
}

async function apply(request: ApplyRequest): Promise<ApplyResponse> {
  await journal(request);

  routes = request.routes;
  httpPort = request.httpPort;
  httpsPort = request.httpsPort;

  const current = await readHosts();
  const next = applyBlock(current, managedHostnames());
  const changed = next !== current;
  if (changed) await writeHosts(next);

  // `dnsFlushed` is always false: `killall -HUP mDNSResponder` needs root and
  // would disturb name resolution for the whole machine.
  return { ok: true, hostsChanged: changed, dnsFlushed: false, routes: routes.length };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Refuses to unlink anything that is not a socket, same as the real helper. */
function unlinkStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  if (!statSync(path).isSocket()) {
    throw new Error(`${path} exists and is not a socket; refusing to remove it`);
  }
  unlinkSync(path);
}

unlinkStaleSocket(socketPath);

const server = Bun.serve({
  unix: socketPath,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") return json(await status());

    if (req.method === "POST" && url.pathname === "/apply") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return failure("request body is not valid JSON", 400);
      }
      const validated = validate(body);
      if (!validated.ok) return failure(`invalid ApplyRequest: ${validated.error}`, 400);
      return json(await apply(validated.value));
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      queueMicrotask(() => stop(0));
      return json({ ok: true });
    }

    return failure(`no route for ${req.method} ${url.pathname}`, 404);
  },
});

function stop(code: number): never {
  server.stop(true);
  try {
    if (existsSync(socketPath) && statSync(socketPath).isSocket()) unlinkSync(socketPath);
  } catch {
    // Best effort: the controller unlinks it too.
  }
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => stop(0));
}

console.log(`[fake-helper] listening on ${socketPath} (hosts=${process.env.LA_HOSTS_PATH})`);
