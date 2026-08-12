/**
 * Every environment override the root daemon honours, resolved lazily.
 *
 * These are read on each call rather than captured at import time so a test (or
 * `scripts/dev.sh`) can set them before the first bind without worrying about module
 * evaluation order — the same late-binding discipline core's `hostsPath()` uses.
 */
import { SOCKET_PATH } from "@localhost-aliases/core";

/**
 * Where the control socket is bound.
 *
 * Deliberately NOT the frozen `SOCKET_PATH` constant unconditionally: `/var/run` is
 * root-only, so tests and the e2e fake helper must be able to point everything at a temp
 * directory. Core's `helperSocketPath()` reads the same variable, so both ends agree.
 */
export function socketPath(): string {
  return process.env.LA_SOCKET_PATH ?? SOCKET_PATH;
}

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}="${raw}" is not a valid port (1-65535)`);
  }
  return port;
}

/** Listener ports used before the first ApplyRequest arrives. */
export function initialHttpPort(): number {
  return portFromEnv("LA_HTTP_PORT", 80);
}
export function initialHttpsPort(): number {
  return portFromEnv("LA_HTTPS_PORT", 443);
}

/**
 * uid the control socket is handed to after bind. Set by `install.sh` from `SUDO_USER`.
 * When it is absent (dev, tests) the socket keeps root's ownership and mode 0600, which is
 * still correct — it is just only reachable by whoever started the process.
 */
export function ownerUid(): number | null {
  const raw = process.env.LA_OWNER_UID;
  if (raw === undefined || raw.trim() === "") return null;
  const uid = Number(raw);
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
}
