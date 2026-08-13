#!/usr/bin/env bun
/**
 * The root TCP forwarder. It binds each route's `ip:listenPort` and splices raw bytes to
 * 127.0.0.1:targetPort. It parses nothing, installs nothing, and exits by itself when the
 * app stops touching the liveness file — a user process cannot kill a root one.
 */
import { LIVENESS_TIMEOUT_MS, LIVENESS_TOUCH_MS } from "@localhost-aliases/core/paths";
import { Forwarder } from "./forwarder.ts";
import { watchLiveness } from "./liveness.ts";
import { stderrLog } from "./log.ts";

export { Forwarder } from "./forwarder.ts";
export { watchLiveness } from "./liveness.ts";
export { parseRoutes, readRoutes, routeKey } from "./routes.ts";

/** Env overrides exist so tests can run the real binary with short timeouts. */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export async function main(): Promise<void> {
  const log = stderrLog;
  const forwarder = new Forwarder({ log });
  await forwarder.start();

  let exiting = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    log(`shutting down: ${reason}`);
    liveness.stop();
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
  // A single bad connection must never take the whole forwarder down.
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err)}`));
}

/**
 * Start only when this file really is the process: `bun test` also reports `import.meta.main`
 * for every file it loads, and a forwarder started by a test run would bind ports and write
 * into the user's real config directory. `bun test` sets NODE_ENV=test; LA_FORWARDER_AUTOSTART
 * is the escape hatch for anything that has to run with that inherited.
 */
const autostart = process.env.LA_FORWARDER_AUTOSTART === "1" || process.env.NODE_ENV !== "test";
if (import.meta.main && autostart) await main();
