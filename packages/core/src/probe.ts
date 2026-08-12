/**
 * Liveness probing: a TCP connect attempt against the upstream port.
 *
 * Deliberately cheap — the dashboard polls this every few seconds for every
 * alias, so probes are short-lived, bounded in time and bounded in parallelism.
 */
import type { Alias, AliasStatus, AliasView, Config } from "./types.ts";
import { hostnameFor, urlFor } from "./validation.ts";

/** Loopback connects either succeed or fail almost instantly. */
const DEFAULT_TIMEOUT_MS = 300;
const MAX_CONCURRENCY = 8;

/** Errors that mean "nothing is listening", as opposed to "we cannot tell". */
const DOWN_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EHOSTDOWN",
  "EAGAIN",
]);

const NOOP_HANDLERS = {
  open() {},
  data() {},
  close() {},
  error() {},
  drain() {},
};

function classify(error: unknown): AliasStatus {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DOWN_CODES.has(code) ? "down" : "unknown";
}

/** "up" on connect, "down" on refusal/timeout, "unknown" on anything else. */
export async function probePort(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AliasStatus> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "unknown";

  let attempt: Promise<AliasStatus>;
  try {
    attempt = Bun.connect({ hostname: host, port, socket: NOOP_HANDLERS }).then(
      (socket) => {
        // We only care that the handshake completed.
        socket.end();
        return "up" as AliasStatus;
      },
      // Attached here (rather than after the race) so a late rejection is never
      // an unhandled promise rejection when the timeout wins.
      classify,
    );
  } catch (error) {
    return classify(error);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<AliasStatus>((resolve) => {
    timer = setTimeout(() => resolve("down"), timeoutMs);
  });

  try {
    return await Promise.race([attempt, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** Probes every alias with a concurrency cap of 8. Keyed by alias id. */
export async function probeAll(
  aliases: Alias[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Map<string, AliasStatus>> {
  const statuses = new Map<string, AliasStatus>();
  const pending = [...(aliases ?? [])];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const alias = pending[cursor++];
      if (!alias) return;
      statuses.set(alias.id, await probePort(alias.target, alias.port, timeoutMs));
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, pending.length) }, worker);
  await Promise.all(workers);
  return statuses;
}

export function toView(alias: Alias, config: Config, status: AliasStatus): AliasView {
  const listenerPort = config.https ? config.httpsPort : config.httpPort;
  return {
    ...alias,
    hostname: hostnameFor(alias.name, config.tld),
    url: urlFor(alias.name, config.tld, config.https, listenerPort),
    status,
  };
}
