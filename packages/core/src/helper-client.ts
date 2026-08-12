/**
 * Typed client for the privileged helper daemon.
 *
 * The helper speaks plain HTTP over a unix socket, so every request goes through
 * `fetch(url, { unix })`. The host part of the URL is meaningless — it only exists
 * because fetch requires a well-formed URL.
 *
 * Nothing here ever throws: the dashboard has to render fine when the helper is
 * not installed, so every failure comes back as a `HelperResult`.
 */
import { existsSync } from "node:fs";
import { HELPER_LABEL, HELPER_PLIST_PATH, SOCKET_PATH } from "./paths.ts";
import type {
  ApplyRequest,
  ApplyResponse,
  Config,
  HelperStatus,
  HelperUnavailable,
  Route,
} from "./types.ts";
import { hostnameFor } from "./validation.ts";

export type HelperResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: "unreachable" | "error" };

/** Every helper call gives up after this long. The UI must never hang on the daemon. */
export const HELPER_TIMEOUT_MS = 2000;

/**
 * Control socket location. `LA_SOCKET_PATH` exists so tests and the e2e fake helper
 * can bind a socket inside a temp dir — /var/run is root-only.
 */
export function helperSocketPath(): string {
  return process.env.LA_SOCKET_PATH ?? SOCKET_PATH;
}

/** Copy-pasteable commands surfaced by the "helper unavailable" banner. */
export function helperInstallCommand(): string {
  return "sudo ./scripts/install.sh";
}
export function helperStartCommand(): string {
  return `sudo launchctl kickstart -k system/${HELPER_LABEL}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns undefined when the body is empty or not JSON. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function connectionError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `The helper did not respond within ${HELPER_TIMEOUT_MS}ms.`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Cannot reach the helper on ${helperSocketPath()}: ${detail}`;
}

async function helperFetch<T>(path: string, init?: RequestInit): Promise<HelperResult<T>> {
  let res: Response;
  try {
    res = await fetch(`http://localhost${path}`, {
      ...init,
      unix: helperSocketPath(),
      signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
    });
  } catch (err) {
    // Socket missing, connection refused, timeout: the helper is simply not there.
    return { ok: false, error: connectionError(err), code: "unreachable" };
  }

  try {
    const body = await readJson(res);
    if (!res.ok || (isRecord(body) && body.ok === false)) {
      const message =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `The helper responded with HTTP ${res.status}.`;
      return { ok: false, error: message, code: "error" };
    }
    if (body === undefined) {
      return { ok: false, error: "The helper returned a non-JSON response.", code: "error" };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    // Body read failed mid-stream — the connection died, not a protocol error.
    return { ok: false, error: connectionError(err), code: "unreachable" };
  }
}

export async function helperStatus(): Promise<HelperResult<HelperStatus>> {
  return helperFetch<HelperStatus>("/status");
}

export async function helperApply(req: ApplyRequest): Promise<HelperResult<ApplyResponse>> {
  return helperFetch<ApplyResponse>("/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

/**
 * Distinguishes "not installed" from "installed but not running" so the banner can
 * tell the user which command to run. Never throws.
 */
export async function helperAvailability(): Promise<HelperUnavailable> {
  const socket = helperSocketPath();
  const socketExists = existsSync(socket);
  const daemonInstalled = existsSync(HELPER_PLIST_PATH);

  if (!socketExists && !daemonInstalled) {
    return {
      installed: false,
      running: false,
      reason: `The privileged helper is not installed. Run \`${helperInstallCommand()}\` to install it.`,
    };
  }

  if (!socketExists) {
    return {
      installed: true,
      running: false,
      reason: `The helper is installed but its socket (${socket}) is missing, so it is not running. Start it with \`${helperStartCommand()}\`.`,
    };
  }

  const status = await helperStatus();
  if (status.ok) {
    return { installed: true, running: true, reason: null };
  }
  if (status.code === "unreachable") {
    return {
      installed: true,
      running: false,
      // A leftover socket file after a crash looks identical to a live one until we connect.
      reason: `The helper socket (${socket}) exists but nothing is listening on it. Start the helper with \`${helperStartCommand()}\`.`,
    };
  }
  return {
    installed: true,
    running: true,
    reason: `The helper is running but returned an error: ${status.error}`,
  };
}

// ---------------------------------------------------------------------------
// Desired state
// ---------------------------------------------------------------------------

/** Disabled aliases keep their config but are never routed. */
export function buildRoutes(config: Config): Route[] {
  return config.aliases
    .filter((alias) => alias.enabled)
    .map((alias) => ({
      host: hostnameFor(alias.name, config.tld),
      target: alias.target || "127.0.0.1",
      port: alias.port,
      aliasId: alias.id,
    }));
}

export function buildApplyRequest(
  config: Config,
  tls: { cert: string; key: string } | null,
): ApplyRequest {
  return {
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    routes: buildRoutes(config),
    // Material is only handed over when the user actually enabled HTTPS.
    tls: config.https ? tls : null,
  };
}
