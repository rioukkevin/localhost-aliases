/**
 * The forwarder runs as root and the app cannot kill it, so it owns its own lifetime:
 * the app touches a liveness file, and when that stops the forwarder exits.
 *
 * Exiting wrongly is worse than exiting late, so a single bad observation is never enough:
 *   - a missing file during the startup grace period is not stale (the app may still be writing it)
 *   - `misses` consecutive stale observations are required
 *   - stat errors other than "not found" (a slow or wedged filesystem) do not count
 *   - a tick that arrives late — laptop sleep, a stalled disk — resets the count, so the app
 *     gets a fair chance to touch the file before we act on what we saw
 */
import { stat } from "node:fs/promises";
import { LIVENESS_TIMEOUT_MS, LIVENESS_TOUCH_MS, livenessPath } from "@localhost-aliases/core/paths";
import { type Logger, silentLog } from "./log.ts";

export interface LivenessOptions {
  path?: string;
  /** How stale the file may get. */
  timeoutMs?: number;
  /** How often we look. */
  intervalMs?: number;
  /** A missing file is tolerated this long after start. Defaults to `timeoutMs`. */
  graceMs?: number;
  /** Consecutive stale observations required before giving up. */
  misses?: number;
  onExpire: (reason: string) => void;
  log?: Logger;
  /** Injectable clock. Tests use it to simulate a stalled process without waiting. */
  now?: () => number;
}

export interface LivenessWatcher {
  stop(): void;
}

export function watchLiveness(opts: LivenessOptions): LivenessWatcher {
  const path = opts.path ?? livenessPath();
  const timeoutMs = opts.timeoutMs ?? LIVENESS_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? LIVENESS_TOUCH_MS;
  const graceMs = opts.graceMs ?? timeoutMs;
  const maxMisses = opts.misses ?? 2;
  const log = opts.log ?? silentLog;
  const now_ = opts.now ?? Date.now;

  const startedAt = now_();
  let lastTick = startedAt;
  let misses = 0;
  let done = false;

  const tick = async (): Promise<void> => {
    if (done) return;
    const now = now_();
    const late = now - lastTick > intervalMs * 2;
    lastTick = now;
    if (late) {
      // We were stalled, not the app. Anything we measured now is unreliable.
      if (misses > 0) log("liveness check ran late; resetting the stale count");
      misses = 0;
      return;
    }

    let reason: string | null = null;
    try {
      const info = await stat(path);
      const age = now - info.mtimeMs;
      if (age > timeoutMs) reason = `liveness file is ${Math.round(age / 1000)}s old`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log(`liveness check failed (${code ?? "unknown"}); ignoring`);
        return; // a slow or broken filesystem must not look like a dead app
      }
      if (now - startedAt < graceMs) return; // app has not written it yet
      reason = "liveness file is missing";
    }

    if (!reason) {
      misses = 0;
      return;
    }
    misses += 1;
    log(`${reason} (${misses}/${maxMisses})`);
    if (misses < maxMisses) return;
    done = true;
    clearInterval(timer);
    opts.onExpire(reason);
  };

  // Deliberately not unref'd: with no routes bound this timer is the only thing keeping
  // the process alive, and a forwarder with nothing to do must still wait for routes.
  const timer = setInterval(() => void tick(), intervalMs);

  return {
    stop() {
      done = true;
      clearInterval(timer);
    },
  };
}
