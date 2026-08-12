/**
 * The control API: plain HTTP over a unix socket, three endpoints, nothing else.
 *
 * This is the entire attack surface of a root process, so it is deliberately small and
 * says no by default. Authorisation is filesystem permissions: the socket is chowned to
 * the installing user and chmod 0600, so no other local account can even connect.
 */
import { chmodSync, chownSync, existsSync, statSync, unlinkSync } from "node:fs";
import type { Server } from "bun";

/** The control socket has no websocket handler, so its per-socket data type is `undefined`. */
type ControlServer = Server<undefined>;
import type { ApplyRequest, ApplyResponse, HelperError, HelperStatus } from "@localhost-aliases/core";
import { ownerUid, socketPath } from "./env.ts";
import { log, reason } from "./log.ts";

export interface ControlHandlers {
  status(): Promise<HelperStatus>;
  apply(request: ApplyRequest): Promise<ApplyResponse>;
  shutdown(): void;
}

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

/**
 * Removes a socket file left behind by a crash or an ungraceful `launchctl bootout`.
 * Refuses to unlink anything that is not a socket — this path comes from the environment,
 * and a typo must never let root delete a regular file.
 */
export function unlinkStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  const stats = statSync(path);
  if (!stats.isSocket()) {
    throw new Error(`${path} exists and is not a socket; refusing to remove it`);
  }
  unlinkSync(path);
  log("control.stale_socket_removed", { path });
}

/** chown to the installing user, then 0600. Failure here is fatal: an open socket is worse. */
function secureSocket(path: string): void {
  const uid = ownerUid();
  if (uid !== null) {
    chownSync(path, uid, statSync(path).gid);
  }
  chmodSync(path, 0o600);
  log("control.socket_secured", { path, uid, mode: "0600" });
}

export function startControlServer(handlers: ControlHandlers): ControlServer {
  const path = socketPath();
  unlinkStaleSocket(path);

  // Closes the window between bind and chmod: the socket is never group/other accessible,
  // not even for the microseconds it takes to fix its mode.
  const previousUmask = process.umask(0o077);
  let server: ControlServer;
  try {
    server = Bun.serve({
      unix: path,
      async fetch(req) {
        const url = new URL(req.url);
        try {
          if (req.method === "GET" && url.pathname === "/status") {
            return json(await handlers.status());
          }
          if (req.method === "POST" && url.pathname === "/apply") {
            let body: unknown;
            try {
              body = await req.json();
            } catch {
              return failure("request body is not valid JSON", 400);
            }
            const result = await handlers.apply(body as ApplyRequest);
            return json(result);
          }
          if (req.method === "POST" && url.pathname === "/shutdown") {
            // Answer first: the caller must not see a connection reset instead of an ack.
            queueMicrotask(() => handlers.shutdown());
            return json({ ok: true });
          }
        } catch (error) {
          const message = reason(error);
          log("control.error", { method: req.method, path: url.pathname, error: message });
          return failure(message, 400);
        }
        return failure(`no route for ${req.method} ${url.pathname}`, 404);
      },
    });
  } finally {
    process.umask(previousUmask);
  }

  secureSocket(path);
  log("control.listening", { socket: path });
  return server;
}

/** Best-effort cleanup so the next start does not have to reason about a stale file. */
export function removeSocket(path: string): void {
  try {
    if (existsSync(path) && statSync(path).isSocket()) unlinkSync(path);
  } catch (error) {
    log("control.socket_cleanup_failed", { path, error: reason(error) });
  }
}
