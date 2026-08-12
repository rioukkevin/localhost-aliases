/**
 * Helper drift recovery.
 *
 * The helper is stateless by design: it holds routes only because someone applied
 * them. The dashboard pushes on every mutation and once at startup, which covers
 * "daemon boots, then dashboard boots". It does not cover the reverse — the helper
 * restarting (crash, `launchctl kickstart`, an auto-update) under a dashboard that
 * keeps running. `/etc/hosts` still resolves every alias, so every site silently
 * becomes the branded 404 page until the user happens to edit something.
 *
 * So: every time we already have a fresh `HelperStatus` in hand, compare it with
 * what the config says the helper should be doing and re-apply when they disagree.
 * `getStatus()` is the only caller — it is polled by the dashboard's status strip,
 * so this rides an existing timer and adds none of its own.
 *
 * ## Why a fingerprint of observable state, and not an epoch counter
 *
 * An epoch echoed back in `HelperStatus` would be a cleaner equality check, but it
 * means widening `ApplyRequest` *and* `HelperStatus` — `packages/core/src/types.ts`,
 * the frozen contract every process compiles against — plus the helper and the e2e
 * fake helper, to detect one extra case: a route whose upstream port changed while
 * the host set and the route count stayed identical.
 *
 * That case cannot happen here. This process is the only writer of helper state, and
 * every write path already pushes synchronously; the only way state diverges behind
 * our back is the helper losing all of it, which shows up unambiguously as
 * `routes: 0`. So the fingerprint compares everything `HelperStatus` actually
 * exposes — route count, managed hostnames, both listener ports, whether TLS is
 * listening — which is strictly more than a count-plus-hosts check and costs no
 * contract change.
 */
import { buildRoutes, type Config, type HelperStatus } from "@localhost-aliases/core";
import { pushDesiredState } from "./desired-state.ts";

/** First retry delay after an ineffective apply; doubles from here. */
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

export type ReconcileAction =
  /** Helper state already matches the config; nothing was sent. */
  | "in-sync"
  /** Drift found and the re-apply succeeded. */
  | "repaired"
  /** Drift found and the re-apply failed; a retry is scheduled. */
  | "failed"
  /** Drift found but we are waiting out the backoff, or another apply is in flight. */
  | "deferred"
  /** No `HelperStatus` to compare against — the helper is not reachable. */
  | "unknown";

export interface ReconcileOutcome {
  action: ReconcileAction;
  /** Non-null only when `action` is "failed". */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

function fingerprint(parts: {
  routes: number;
  hosts: string[];
  httpPort: number;
  httpsPort: number;
  tls: boolean;
}): string {
  // The managed block is a set, not a list: sort so ordering is never drift.
  const hosts = [...new Set(parts.hosts.map((host) => host.toLowerCase()))].sort();
  return JSON.stringify({ ...parts, hosts });
}

/** What the helper should look like if the current config were applied. */
export function desiredFingerprint(config: Config): string {
  const routes = buildRoutes(config);
  return fingerprint({
    routes: routes.length,
    hosts: routes.map((route) => route.host),
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    tls: config.https,
  });
}

/** What the helper says it is actually doing. */
export function observedFingerprint(status: HelperStatus): string {
  return fingerprint({
    routes: status.routes,
    hosts: status.managedHosts,
    httpPort: status.http.port,
    httpsPort: status.https.port,
    tls: status.https.listening,
  });
}

export function hasDrifted(config: Config, status: HelperStatus): boolean {
  return desiredFingerprint(config) !== observedFingerprint(status);
}

/**
 * Names the dimensions that actually diverge, as `observed -> desired`.
 *
 * The fingerprint covers five things, and only one of them is the route count, so
 * a log line phrased purely in route counts can read "helper has 1 route(s), config
 * wants 1" while the hostnames or the listener port are what moved. This says which.
 */
export function describeDrift(config: Config, status: HelperStatus): string {
  const routes = buildRoutes(config);
  const normalize = (hosts: string[]): string[] =>
    [...new Set(hosts.map((host) => host.toLowerCase()))].sort();
  const wanted = normalize(routes.map((route) => route.host));
  const observed = normalize(status.managedHosts);

  const diffs: string[] = [];
  if (routes.length !== status.routes) diffs.push(`routes ${status.routes} -> ${routes.length}`);
  if (wanted.join(",") !== observed.join(",")) {
    diffs.push(`hosts [${observed.join(" ")}] -> [${wanted.join(" ")}]`);
  }
  if (config.httpPort !== status.http.port) {
    diffs.push(`http port ${status.http.port} -> ${config.httpPort}`);
  }
  if (config.httpsPort !== status.https.port) {
    diffs.push(`https port ${status.https.port} -> ${config.httpsPort}`);
  }
  if (config.https !== status.https.listening) {
    diffs.push(`tls ${status.https.listening ? "on" : "off"} -> ${config.https ? "on" : "off"}`);
  }
  // Unreachable while the fingerprint covers exactly these five dimensions, but a
  // silent empty parenthesis would be a worse way to find that out.
  return diffs.length > 0 ? diffs.join(", ") : "helper state differs";
}

// ---------------------------------------------------------------------------
// Process-local reconcile state
// ---------------------------------------------------------------------------

/**
 * Consecutive attempts that did not end with the helper matching the config —
 * whether the apply errored or "succeeded" without taking effect. Zero means
 * healthy, so a single successful repair resets it on the very next poll.
 */
let ineffectiveAttempts = 0;
let nextAttemptAt = 0;
/** The desired state we last pushed; a change to it means a fresh situation. */
let lastAttempted: string | null = null;
let inFlight = false;
/** Last line written, so a stuck condition logs once instead of every poll. */
let lastLogged = "";

/** Exported for tests: module state outlives a single test otherwise. */
export function resetReconcileState(): void {
  ineffectiveAttempts = 0;
  nextAttemptAt = 0;
  lastAttempted = null;
  inFlight = false;
  lastLogged = "";
}

function logOnce(line: string): void {
  if (line === lastLogged) return;
  lastLogged = line;
  console.log(line);
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

function healthy(): ReconcileOutcome {
  ineffectiveAttempts = 0;
  nextAttemptAt = 0;
  lastAttempted = null;
  // Silent on the happy path, but armed: the next drift logs even if it is
  // word-for-word the message we printed before.
  lastLogged = "";
  return { action: "in-sync", warning: null };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Compares desired and observed state and re-applies on divergence.
 *
 * Never throws: the caller is a status read that has to render whatever happens.
 * Cheap in the common case — one string comparison, no I/O — and single-flighted,
 * because concurrent dashboards poll the same server.
 */
export async function reconcileHelper(
  config: Config,
  status: HelperStatus | null,
): Promise<ReconcileOutcome> {
  // Nothing to compare against. Not an error: the helper being absent is the
  // normal first-run state, and applying to a helper that did not answer /status
  // would just be a second timeout on every poll.
  if (status === null) return { action: "unknown", warning: null };

  const desired = desiredFingerprint(config);
  if (desired === observedFingerprint(status)) return healthy();

  if (inFlight) return { action: "deferred", warning: null };

  // A different desired state is a new situation, not a continuing failure.
  if (desired !== lastAttempted) {
    ineffectiveAttempts = 0;
    nextAttemptAt = 0;
  }

  const now = Date.now();
  if (now < nextAttemptAt) {
    // No countdown in this line: it is deduplicated by exact text, and a value
    // that ticks every second would defeat that and log once per poll forever.
    // The delay is already stated by the failure line that armed the backoff.
    logOnce("[api] helper still out of sync; waiting out the backoff before the next re-apply");
    return { action: "deferred", warning: null };
  }

  logOnce(`[api] helper drift detected (${describeDrift(config, status)}) — re-applying desired state`);

  lastAttempted = desired;
  ineffectiveAttempts += 1;
  inFlight = true;
  let warning: string | null;
  try {
    warning = await pushDesiredState(config);
  } finally {
    inFlight = false;
  }

  // The backoff is armed even on success: if the apply is accepted but the helper
  // still does not match, the next poll sees the same drift and must not hammer.
  nextAttemptAt = Date.now() + backoffMs(ineffectiveAttempts);

  if (warning === null) {
    logOnce(`[api] helper re-synced: ${buildRoutes(config).length} route(s) re-applied`);
    return { action: "repaired", warning: null };
  }

  logOnce(
    `[api] helper re-apply failed (attempt ${ineffectiveAttempts}, retrying in ${
      backoffMs(ineffectiveAttempts) / 1000
    }s): ${warning}`,
  );
  return { action: "failed", warning };
}
