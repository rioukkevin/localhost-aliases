/**
 * Binding and rebinding the public listeners.
 *
 * Two rules shape this file:
 *  - A route change must NOT rebind anything (the handlers read the shared RouteTable), so
 *    `apply` is a no-op unless the port or the TLS material actually changed.
 *  - A rebind must never take the control socket down with it, so listeners are owned here
 *    and the control server is a completely separate `Bun.serve` in index.ts.
 */
import type { Server } from "bun";
import { log, reason } from "./log.ts";
import { createHandlers, type SocketData } from "./proxy.ts";
import type { RouteTable } from "./routes.ts";

export interface TlsMaterial {
  cert: string;
  key: string;
}

/**
 * Loopback addresses we bind.
 *
 * The managed /etc/hosts block emits both an A record (127.0.0.1) and an AAAA record (::1)
 * for every alias, and macOS resolvers routinely try the v6 address first — so both have to
 * be listening. Binding loopback only (rather than 0.0.0.0) is deliberate: nothing on the
 * LAN can reach a dev server through this proxy.
 */
const BIND_ADDRESSES = ["127.0.0.1", "::1"] as const;

export class ProxyListener {
  private servers: Array<Server<SocketData>> = [];
  private boundPort = 0;
  private boundTls: TlsMaterial | null = null;

  constructor(
    private readonly table: RouteTable,
    private readonly proto: "http" | "https",
  ) {}

  get listening(): boolean {
    return this.servers.length > 0;
  }

  /** 0 when not listening — `HelperStatus` reports the port it *wants* separately. */
  get port(): number {
    return this.boundPort;
  }

  private sameAs(port: number, tls: TlsMaterial | null): boolean {
    if (!this.listening || port !== this.boundPort) return false;
    if ((tls === null) !== (this.boundTls === null)) return false;
    if (tls === null || this.boundTls === null) return true;
    return tls.cert === this.boundTls.cert && tls.key === this.boundTls.key;
  }

  /**
   * Binds `port` (rebinding only when something material changed). On failure the previous
   * binding is restored when possible, so a bad apply cannot leave the machine with no
   * proxy at all; the error is rethrown either way.
   */
  async apply(port: number, tls: TlsMaterial | null): Promise<void> {
    if (this.sameAs(port, tls)) return;

    const previous = this.listening ? { port: this.boundPort, tls: this.boundTls } : null;
    await this.stop();
    try {
      this.bind(port, tls);
    } catch (error) {
      const message = reason(error);
      log("listener.bind_failed", { proto: this.proto, port, error: message });
      if (previous) {
        try {
          this.bind(previous.port, previous.tls);
          log("listener.restored", { proto: this.proto, port: previous.port });
        } catch {
          log("listener.restore_failed", { proto: this.proto, port: previous.port });
        }
      }
      throw new Error(`cannot bind ${this.proto} port ${port}: ${message}`);
    }
  }

  private bind(port: number, tls: TlsMaterial | null): void {
    const proto = this.proto;
    const handlers = createHandlers({ table: this.table, proto, listenerPort: port });
    const servers: Array<Server<SocketData>> = [];
    for (const hostname of BIND_ADDRESSES) {
      try {
        servers.push(
          Bun.serve({
            hostname,
            port,
            tls: tls ?? undefined,
            // Dev servers stream: SSE, long polls and slow bundles must not be cut off.
            idleTimeout: 0,
            fetch: handlers.fetch,
            websocket: handlers.websocket,
            error: (err: Error) => {
              log("listener.handler_error", { proto, port, error: reason(err), stack: err.stack });
              return new Response("proxy error", { status: 500 });
            },
          }),
        );
      } catch (error) {
        // A machine with IPv6 disabled cannot bind ::1. That is survivable; failing to bind
        // 127.0.0.1 is not.
        if (hostname === "127.0.0.1") {
          for (const server of servers) server.stop(true);
          throw error;
        }
        log("listener.skipped", { proto: this.proto, port, hostname, error: reason(error) });
      }
    }
    this.servers = servers;
    this.boundPort = port;
    this.boundTls = tls;
    log("listener.bound", { proto: this.proto, port, addresses: servers.length });
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    const port = this.boundPort;
    // Force-close: a lingering keep-alive connection would hold the port and make an
    // immediate rebind (same port, new TLS material) fail with EADDRINUSE.
    await Promise.all(this.servers.map((server) => server.stop(true)));
    this.servers = [];
    this.boundPort = 0;
    this.boundTls = null;
    log("listener.stopped", { proto: this.proto, port });
  }
}
