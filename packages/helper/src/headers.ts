/**
 * Hop-by-hop header handling for the reverse proxy.
 *
 * Hop-by-hop headers describe one TCP connection, not the message, so forwarding them
 * corrupts the next hop (a stale `Content-Length`, a `Connection: close` that kills
 * keep-alive, a `Transfer-Encoding` Bun has already undone). RFC 7230 §6.1 also says the
 * `Connection` header itself lists further headers that must not be forwarded.
 */

/** Always stripped, in both directions. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "trailers",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
]);

function isHopByHop(name: string, connectionTokens: Set<string>): boolean {
  return HOP_BY_HOP.has(name) || name.startsWith("proxy-") || connectionTokens.has(name);
}

/** Lowercased header names named by the `Connection` header, e.g. "connection: close, x-foo". */
function connectionTokens(headers: Headers): Set<string> {
  const value = headers.get("connection");
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
}

export interface ForwardContext {
  /** Client IP as seen by the listener, appended to X-Forwarded-For. */
  clientIp: string | null;
  /** "http" or "https" — the scheme the *client* used, not the upstream one. */
  proto: string;
  /** Original Host header, port included. */
  host: string;
}

/**
 * Request headers to send upstream.
 *
 * The original `Host` is forwarded verbatim: dev servers derive absolute URLs and
 * host-based routing from it, and Bun's fetch honours an explicit `host` header.
 *
 * `Accept-Encoding` is forced to `identity` on purpose. Bun's fetch transparently
 * decompresses the upstream response, which would leave `Content-Encoding: gzip` on a body
 * that is no longer gzipped. Asking upstream not to compress removes the whole class of
 * bug, and compression is worthless over loopback anyway.
 */
export function forwardRequestHeaders(source: Headers, ctx: ForwardContext): Headers {
  const skip = connectionTokens(source);
  const out = new Headers();
  for (const [name, value] of source) {
    if (isHopByHop(name, skip)) continue;
    if (name === "accept-encoding") continue;
    out.set(name, value);
  }
  out.set("accept-encoding", "identity");

  const existingFor = source.get("x-forwarded-for");
  if (ctx.clientIp) {
    out.set("x-forwarded-for", existingFor ? `${existingFor}, ${ctx.clientIp}` : ctx.clientIp);
  }
  out.set("x-forwarded-proto", ctx.proto);
  out.set("x-forwarded-host", ctx.host);
  return out;
}

/**
 * Response headers to hand back to the client.
 *
 * If upstream compressed anyway despite `identity`, Bun has already decompressed the body,
 * so `Content-Encoding` and the now-wrong `Content-Length` are both dropped.
 */
export function forwardResponseHeaders(source: Headers): Headers {
  const skip = connectionTokens(source);
  const decompressed = source.has("content-encoding");
  const out = new Headers();
  for (const [name, value] of source) {
    if (isHopByHop(name, skip)) continue;
    if (decompressed && (name === "content-encoding" || name === "content-length")) continue;
    out.set(name, value);
  }
  return out;
}

/** Headers to replay on the upstream WebSocket handshake (the client opens a fresh one). */
export function forwardWebSocketHeaders(source: Headers, ctx: ForwardContext): Record<string, string> {
  const skip = connectionTokens(source);
  const out: Record<string, string> = {};
  for (const [name, value] of source) {
    // Everything `sec-websocket-*` belongs to the handshake the client library performs
    // itself; replaying our client's key or version would produce an invalid request.
    if (isHopByHop(name, skip) || name.startsWith("sec-websocket-")) continue;
    if (name === "accept-encoding") continue;
    out[name] = value;
  }
  if (ctx.clientIp) out["x-forwarded-for"] = ctx.clientIp;
  out["x-forwarded-proto"] = ctx.proto;
  out["x-forwarded-host"] = ctx.host;
  return out;
}
