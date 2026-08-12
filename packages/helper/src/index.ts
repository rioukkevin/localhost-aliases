/**
 * localhost-aliases privileged helper.
 *
 * The only component that runs as root. It owns exactly three things — the control socket,
 * the managed /etc/hosts block, and the :80/:443 listeners — and holds no policy of its own:
 * every `apply` carries the complete desired state, which this process reconciles and then
 * forgets about. Keeping it stateless is what keeps it small enough to audit.
 */
import type { Server } from "bun";
import type { ApplyRequest, ApplyResponse, HelperStatus } from "@localhost-aliases/core";
import pkg from "../package.json";
import { removeSocket, startControlServer } from "./control-server.ts";
import { initialHttpPort, initialHttpsPort, socketPath } from "./env.ts";
import { readManagedHosts, reconcileHosts } from "./hosts-sync.ts";
import { ProxyListener } from "./listeners.ts";
import { log, reason } from "./log.ts";
import { RouteTable, validateApplyRequest } from "./routes.ts";

const VERSION: string = pkg.version;
const startedAt = Date.now();

const table = new RouteTable();
const http = new ProxyListener(table, "http");
const https = new ProxyListener(table, "https");

/** Ports we have been *asked* to serve, which may differ from what is bound after a failure. */
let desiredHttpPort = initialHttpPort();
let desiredHttpsPort = initialHttpsPort();

let control: Server<undefined> | null = null;
let shuttingDown = false;

async function status(): Promise<HelperStatus> {
  return {
    ok: true,
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    http: { listening: http.listening, port: http.listening ? http.port : desiredHttpPort },
    https: { listening: https.listening, port: https.listening ? https.port : desiredHttpsPort },
    routes: table.size,
    managedHosts: await readManagedHosts(),
  };
}

/**
 * Reconcile to the desired state. Order matters:
 *   1. validate — nothing below runs on a request we do not fully trust;
 *   2. swap routes — so the new hostnames resolve the instant a listener accepts traffic;
 *   3. listeners — the only step that can fail, so it happens before /etc/hosts is touched;
 *   4. /etc/hosts + DNS flush.
 *
 * Steps 2 and 3 are one transaction. A bind failure rolls the listeners back on its own, so
 * the route table must roll back with them: otherwise the helper keeps serving the *new*
 * hostnames, which /etc/hosts does not resolve, while the *old* ones still resolve and 404 —
 * every alias broken in the browser until the port conflict clears.
 */
async function apply(raw: ApplyRequest): Promise<ApplyResponse> {
  const validated = validateApplyRequest(raw);
  if (!validated.ok) {
    log("apply.rejected", { error: validated.error });
    throw new Error(`invalid ApplyRequest: ${validated.error}`);
  }
  const request = validated.value;

  const previousRoutes = table.list();
  const previousHttpPort = desiredHttpPort;
  const previousHttpsPort = desiredHttpsPort;

  table.swap(request.routes);
  desiredHttpPort = request.httpPort;
  desiredHttpsPort = request.httpsPort;

  try {
    await http.apply(request.httpPort, null);
    if (request.tls) await https.apply(request.httpsPort, request.tls);
    else await https.stop();
  } catch (error) {
    table.swap(previousRoutes);
    desiredHttpPort = previousHttpPort;
    desiredHttpsPort = previousHttpsPort;
    log("apply.rolledback", { error: String(error), routes: table.size });
    throw error;
  }

  const hosts = await reconcileHosts(table.hosts());

  log("apply", {
    routes: table.size,
    httpPort: http.port,
    httpsPort: https.listening ? https.port : null,
    tls: request.tls !== null,
    hostsChanged: hosts.changed,
    dnsFlushed: hosts.dnsFlushed,
    hosts: hosts.hostnames,
  });

  return { ok: true, hostsChanged: hosts.changed, dnsFlushed: hosts.dnsFlushed, routes: table.size };
}

async function shutdown(code: number, why: string): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  log("shutdown", { why });
  await http.stop().catch(() => {});
  await https.stop().catch(() => {});
  control?.stop(true);
  removeSocket(socketPath());
  process.exit(code);
}

async function main(): Promise<void> {
  log("start", { version: VERSION, pid: process.pid, uid: process.getuid?.() ?? null, socket: socketPath() });

  // Registered before anything is bound, so a launchd stop during startup still cleans up.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(0, signal));
  }

  // The control socket comes up first and unconditionally: if :80 is taken by something
  // else, the dashboard still needs a way to ask us what is wrong.
  control = startControlServer({ status, apply, shutdown: () => void shutdown(0, "control:/shutdown") });

  try {
    await http.apply(desiredHttpPort, null);
  } catch (error) {
    // Not fatal. Reported through /status as `http.listening: false`; a later apply retries.
    log("start.http_bind_failed", { port: desiredHttpPort, error: reason(error) });
  }

  log("ready", { http: http.listening ? http.port : null, socket: socketPath() });
}

await main();
