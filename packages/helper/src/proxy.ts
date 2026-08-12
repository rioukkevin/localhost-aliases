/**
 * The reverse proxy request path: Host header in, upstream response out.
 *
 * Stateless with respect to configuration — it reads the shared `RouteTable` on every
 * request, which is why swapping routes never needs a listener rebind.
 */
import type { Server, ServerWebSocket } from "bun";
import type { Route } from "@localhost-aliases/core";
import { forwardRequestHeaders, forwardResponseHeaders, forwardWebSocketHeaders } from "./headers.ts";
import { log, reason } from "./log.ts";
import { offlinePage, unknownHostPage, upstreamErrorPage } from "./pages.ts";
import { hostKey, type RouteTable } from "./routes.ts";

/** "127.0.0.1:3000" / "[::1]:3000" — IPv6 literals need brackets in a URL authority. */
function authority(target: string, port: number): string {
  return target.includes(":") ? `[${target}]:${port}` : `${target}:${port}`;
}

/** Bun surfaces a refused TCP connect as `code: "ConnectionRefused"`. */
function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return true;
  return /econnrefused|connectionrefused|unable to connect/i.test(reason(error));
}

/**
 * Close codes a WebSocket endpoint is allowed to *send*. 1005/1006 are synthesised locally
 * when a peer goes away without a code, and echoing one back is a protocol violation.
 */
function sendableCloseCode(code: number | undefined): number {
  if (typeof code !== "number") return 1000;
  if (code >= 3000 && code <= 4999) return code;
  if ([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code)) return code;
  return 1000;
}

/** Statuses that must not carry a body; `new Response(stream, { status: 304 })` throws. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Frames buffered while the upstream handshake completes. A browser sends one or two. */
const MAX_QUEUED_FRAMES = 64;

/** Everything the websocket handlers need, carried on `ws.data`. */
export interface SocketData {
  route: Route;
  url: string;
  headers: Record<string, string>;
  protocols: string[];
  upstream: WebSocket | null;
  /** Frames received from the browser before the upstream handshake completed. */
  queue: Array<string | Uint8Array>;
  clientClosed: boolean;
}

export interface HandlerOptions {
  table: RouteTable;
  proto: "http" | "https";
  /** Port this listener is bound to; only used to build links on the 404 page. */
  listenerPort: number;
}

export function createHandlers(options: HandlerOptions) {
  const { table, proto, listenerPort } = options;

  async function fetchHandler(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const hostHeader = req.headers.get("host");
    const route = table.lookup(hostHeader);

    if (!route) {
      return unknownHostPage(hostKey(hostHeader), table.list(), { proto, listenerPort });
    }

    const url = new URL(req.url);
    const clientIp = server.requestIP(req)?.address ?? null;
    const ctx = { clientIp, proto, host: hostHeader ?? route.host };

    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const requested = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token !== "");
      const data: SocketData = {
        route,
        // Upstream is always plain ws:// — dev servers on loopback do not speak TLS.
        url: `ws://${authority(route.target, route.port)}${url.pathname}${url.search}`,
        headers: forwardWebSocketHeaders(req.headers, ctx),
        protocols: requested,
        upstream: null,
        queue: [],
        clientClosed: false,
      };
      // The 101 goes out before the upstream handshake, so a dead upstream shows up as an
      // immediate close rather than a failed upgrade. Dev clients reconnect on that anyway.
      const upgraded = server.upgrade(req, {
        data,
        // Echo the first requested subprotocol: vite's HMR client insists on "vite-hmr".
        headers: requested[0] ? { "sec-websocket-protocol": requested[0] } : undefined,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const target = `http://${authority(route.target, route.port)}${url.pathname}${url.search}`;
    try {
      /*
       * The request body is buffered rather than piped through as `req.body`.
       *
       * Bun 1.2.5 bug, isolated by bisection: forwarding the inbound ReadableStream to
       * `fetch` (with `duplex: "half"`) corrupts the listener afterwards — the *next* fresh
       * connection to that same listener is answered with an empty HTTP 400 before the
       * handler ever runs. One proxied form POST was enough to break the next page load.
       * Buffering removes it completely. The cost is that a huge upload is held in memory;
       * for a loopback dev proxy that is the right trade, and this can go back to streaming
       * once the runtime is fixed.
       */
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      const upstream = await fetch(target, {
        method: req.method,
        headers: forwardRequestHeaders(req.headers, ctx),
        body,
        // Redirects belong to the browser; a proxy that follows them hides the Location.
        redirect: "manual",
      });

      // A 304 from a dev server answering a conditional request is the common case here.
      return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardResponseHeaders(upstream.headers),
      });
    } catch (error) {
      if (isConnectionRefused(error)) {
        log("proxy.offline", { host: route.host, target: route.target, port: route.port, method: req.method, path: url.pathname });
        return offlinePage(route);
      }
      const detail = reason(error);
      log("proxy.error", { host: route.host, target: route.target, port: route.port, method: req.method, path: url.pathname, error: detail });
      return upstreamErrorPage(route, detail);
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket relay: browser <-> this process <-> upstream dev server
  // -------------------------------------------------------------------------

  function openUpstream(ws: ServerWebSocket<SocketData>): void {
    const data = ws.data;
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(data.url, {
        headers: data.headers,
        protocols: data.protocols.length > 0 ? data.protocols : undefined,
      } as unknown as string[]);
    } catch (error) {
      log("proxy.ws_error", { host: data.route.host, port: data.route.port, error: reason(error) });
      ws.close(1011, "upstream unavailable");
      return;
    }
    upstream.binaryType = "arraybuffer";
    data.upstream = upstream;

    upstream.onopen = () => {
      for (const frame of data.queue) upstream.send(frame);
      data.queue.length = 0;
      if (data.clientClosed) upstream.close(1000, "");
    };
    upstream.onmessage = (event: MessageEvent) => {
      const payload = event.data;
      if (typeof payload === "string") ws.send(payload);
      else if (payload instanceof ArrayBuffer) ws.send(new Uint8Array(payload));
      else if (ArrayBuffer.isView(payload)) ws.send(payload as Uint8Array);
    };
    upstream.onclose = (event: CloseEvent) => {
      ws.close(sendableCloseCode(event.code), event.reason ?? "");
    };
    upstream.onerror = () => {
      // `error` on a client socket carries no useful detail; the close event follows.
      log("proxy.ws_error", { host: data.route.host, target: data.route.target, port: data.route.port });
      if (upstream.readyState !== WebSocket.OPEN) ws.close(1011, "upstream unavailable");
    };
  }

  const websocket = {
    open(ws: ServerWebSocket<SocketData>) {
      openUpstream(ws);
    },
    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      const upstream = ws.data.upstream;
      const frame = typeof message === "string" ? message : new Uint8Array(message);
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(frame);
      } else if (ws.data.queue.length < MAX_QUEUED_FRAMES) {
        ws.data.queue.push(frame);
      } else {
        // Never let a client make a root process buffer without bound.
        ws.close(1013, "upstream not ready");
      }
    },
    close(ws: ServerWebSocket<SocketData>, code: number, reasonText: string) {
      ws.data.clientClosed = true;
      const upstream = ws.data.upstream;
      if (!upstream) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.close(sendableCloseCode(code), reasonText ?? "");
      else if (upstream.readyState === WebSocket.CONNECTING) {
        // Nothing to close yet; `onopen` sees `clientClosed` and shuts it down immediately.
        ws.data.queue.length = 0;
      }
    },
  };

  return { fetch: fetchHandler, websocket };
}
