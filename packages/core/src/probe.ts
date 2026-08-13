/**
 * Liveness probing. "up" means something accepted a TCP connection on 127.0.0.1:<port>,
 * which is exactly what the forwarder needs in order to have anything to splice to.
 */
import type { Alias, AliasStatus, AliasView, Config } from "./types.ts";
import { hostnameFor, isValidPort, urlFor } from "./validation.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 400;
export const DEFAULT_PROBE_CONCURRENCY = 8;

/**
 * A single TCP connect. Bun reports refusals and DNS failures with the same code, so
 * anything short of a successful connect is reported as "down"; "unknown" is reserved
 * for input we never even attempted.
 */
export async function probePort(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<AliasStatus> {
  if (!host || !isValidPort(port)) return "unknown";

  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = Bun.connect({
    hostname: host,
    port,
    socket: { data() {}, open() {}, error() {}, close() {} },
  });
  // The connect promise must stay handled even when the timeout wins the race.
  const guarded = connect.then(
    (socket) => {
      socket.end();
      return "up" as const;
    },
    () => "down" as const,
  );

  try {
    return await Promise.race([
      guarded,
      new Promise<AliasStatus>((resolve) => {
        timer = setTimeout(() => resolve("down"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ProbeTarget {
  /** Whatever the caller wants to key results by; the alias id in practice. */
  id: string;
  port: number;
  /** Defaults to 127.0.0.1 — the dev server, not the alias. */
  host?: string;
}

export interface ProbeAllOptions {
  timeoutMs?: number;
  concurrency?: number;
}

/** Probe many targets with a bounded number of sockets open at once. */
export async function probeAll(
  targets: readonly ProbeTarget[],
  options: ProbeAllOptions = {},
): Promise<Record<string, AliasStatus>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_PROBE_CONCURRENCY);
  const results: Record<string, AliasStatus> = {};

  let next = 0;
  async function worker(): Promise<void> {
    while (next < targets.length) {
      const target = targets[next++];
      if (!target) return;
      results[target.id] = await probePort(target.host ?? "127.0.0.1", target.port, timeoutMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}

/** Enrich an alias for display. Never persisted. */
export function toView(alias: Alias, config: Config, status: AliasStatus = "unknown"): AliasView {
  return {
    ...alias,
    hostname: hostnameFor(alias.name, config.tld),
    url: urlFor(alias.name, config.tld),
    status,
  };
}
