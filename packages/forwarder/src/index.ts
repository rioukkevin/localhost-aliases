#!/usr/bin/env bun
/**
 * The root agent (docs/AGENT.md §1) — which is also the TCP forwarder, because they are one
 * process by design: it already exists, already runs as root, and already terminates itself.
 *
 * As root it does two jobs:
 *   - reconcile the machine to desired-state.json whenever that file changes: lo0 aliases,
 *     the /etc/hosts managed block, a DNS flush, and its own routes. No prompt, ever.
 *   - splice raw bytes from each route's `ip:listenPort` to 127.0.0.1:targetPort.
 *
 * It installs nothing and exits by itself when the app stops touching the liveness file —
 * a user process cannot kill a root one, so the root one owns its own lifetime.
 *
 * Unprivileged it degrades to exactly what it was before: a forwarder that watches
 * routes.json. Nothing here tries to reconcile a system it has no rights over.
 */
import { LIVENESS_TIMEOUT_MS, LIVENESS_TOUCH_MS } from "@localhost-aliases/core/paths";
import { Agent } from "./agent.ts";
import { Forwarder } from "./forwarder.ts";
import { watchLiveness } from "./liveness.ts";
import { stderrLog } from "./log.ts";
import { realSystem } from "./system.ts";

export { Agent } from "./agent.ts";
export { Forwarder } from "./forwarder.ts";
export { watchLiveness } from "./liveness.ts";
export { parseDesiredState, isLoopbackIpv4 } from "./desired.ts";
export { offlinePage, offlineResponse, sniffHttpRequest } from "./offline.ts";
export { parseRoutes, readRoutes, routeKey } from "./routes.ts";
export { realSystem, type SystemOps } from "./system.ts";

/** Env overrides exist so tests can run the real binary with short timeouts. */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Reconcile only when we actually can. Being root is the honest test — ifconfig and
 * /etc/hosts need it — and LA_AGENT_RECONCILE forces the answer either way for development.
 */
export function shouldReconcile(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LA_AGENT_RECONCILE === "0") return false;
  if (env.LA_AGENT_RECONCILE === "1") return true;
  return process.getuid?.() === 0;
}

/** LA_MANAGED_IPS is a space-separated list, exactly as apply.sh passes it. */
export function managedIpsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.LA_MANAGED_IPS ?? "").split(/\s+/).filter((ip) => ip.length > 0);
}

export async function main(): Promise<void> {
  const log = stderrLog;
  const reconciling = shouldReconcile();

  // When the agent is driving, the routes come from the desired state it has just validated,
  // so the forwarder must not also be reading routes.json behind its back.
  const forwarder = new Forwarder({ log, watchRoutesFile: !reconciling });
  await forwarder.start();

  const agent = reconciling
    ? new Agent({
        forwarder,
        system: realSystem({ log }),
        managedIps: managedIpsFromEnv(),
        log,
      })
    : null;
  if (agent) {
    log("running as the root agent: reconciling desired-state.json without further prompts");
    await agent.start();
  } else {
    log("running as a plain forwarder: watching routes.json only");
  }

  let exiting = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    log(`shutting down: ${reason}`);
    liveness.stop();
    await agent?.stop();
    await forwarder.stop();
    process.exit(0);
  };

  const liveness = watchLiveness({
    log,
    timeoutMs: envMs("LA_LIVENESS_TIMEOUT_MS", LIVENESS_TIMEOUT_MS),
    intervalMs: envMs("LA_LIVENESS_INTERVAL_MS", LIVENESS_TOUCH_MS),
    onExpire: (reason) => void shutdown(reason),
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // A single bad connection must never take the whole agent down.
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err)}`));
}

/**
 * Start only when this file really is the process: `bun test` also reports `import.meta.main`
 * for every file it loads, and an agent started by a test run would bind ports and write
 * into the user's real config directory. `bun test` sets NODE_ENV=test; LA_FORWARDER_AUTOSTART
 * is the escape hatch for anything that has to run with that inherited.
 */
const autostart = process.env.LA_FORWARDER_AUTOSTART === "1" || process.env.NODE_ENV !== "test";
if (import.meta.main && autostart) await main();
