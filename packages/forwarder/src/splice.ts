/**
 * Raw socket splicing. Bytes in, same bytes out — nothing here parses, buffers whole
 * messages, or knows what a protocol is. That is what makes WebSockets, HMR and any
 * non-HTTP traffic work, and it is also why TLS cannot be terminated for project aliases.
 *
 * Memory: a connection holds at most the tail of one chunk per direction. When a write is
 * only partly accepted we keep the remainder and pause the *source* socket, then retry until
 * the peer catches up and the source is resumed. Nothing is ever queued unbounded.
 *
 * Retrying is not belt-and-braces: in Bun 1.2.5 `drain` means "our own send buffer is empty",
 * and it fires immediately after a partial write — before the peer has read a single byte —
 * and then never again. Waiting for it would deadlock the moment a client reads slowly, so
 * the remainder is re-offered on a short timer (measured: 8MB to a stalled reader still lands
 * in ~0.5s once it resumes).
 *
 * Half-close: Bun 1.2.5 has no true half-open socket — calling `end()` or `shutdown(true)`
 * also stops that socket from delivering data, whatever `allowHalfOpen` says (verified
 * against Bun.connect, Bun.listen and node:net). Relaying a client FIN would therefore throw
 * away the reply that FIN was waiting for, so a FIN is *recorded*, not relayed.
 *
 * The two sockets are therefore configured differently, on purpose:
 *   - the accepted socket runs with `allowHalfOpen: true`, so a client that half-closes after
 *     its request still gets the response written back to it;
 *   - the upstream socket does not, so when the dev server ends a response by closing the
 *     connection we get `close` at once and pass the EOF straight on to the client.
 *
 * The cost is that a client FIN no longer proves the client is gone, so a pair that is
 * finished in one direction and silent in the other is reaped after `lingerSeconds` — a timer
 * re-armed by any byte moving either way, so a slow reply is never cut off.
 */
import type { Socket, SocketHandler } from "bun";
import type { Logger } from "./log.ts";

type Side = "client" | "upstream";

interface Conn {
  client: Socket<SpliceSocketData> | null;
  /** Null until the upstream connection is open — data is queued until then. */
  upstream: Socket<SpliceSocketData> | null;
  /** Bytes waiting to be written *to* that side. */
  pending: Record<Side, Uint8Array[]>;
  /** That side sent a FIN: it will send nothing more. */
  ended: Record<Side, boolean>;
  /** That side's socket is fully closed. */
  gone: Record<Side, boolean>;
  /** We already closed that side. */
  closeSent: Record<Side, boolean>;
  /** Pending retry of a partial write toward that side. */
  retry: Record<Side, ReturnType<typeof setTimeout> | null>;
  /** A FIN was seen and we are waiting on the other direction. */
  lingering: boolean;
  lingerSeconds: number;
  closed: boolean;
}

interface Link {
  conn: Conn;
  side: Side;
}

/** What a spliced socket carries. Undefined only between accept and `open`. */
export type SpliceSocketData = Link | undefined;

/** Total bytes queued across all connections. Bounded by design; asserted in tests. */
let buffered = 0;
export function bufferedBytes(): number {
  return buffered;
}

const other = (side: Side): Side => (side === "client" ? "upstream" : "client");

/** How soon a partially-written chunk is re-offered to a socket that would not take it. */
const RETRY_MS = 5;

function scheduleRetry(conn: Conn, dest: Side): void {
  if (conn.retry[dest] || conn.closed) return;
  conn.retry[dest] = setTimeout(() => {
    conn.retry[dest] = null;
    pump(conn, dest);
  }, RETRY_MS);
}

function cancelRetry(conn: Conn, dest: Side): void {
  const timer = conn.retry[dest];
  if (!timer) return;
  clearTimeout(timer);
  conn.retry[dest] = null;
}

function newConn(lingerSeconds: number): Conn {
  return {
    client: null,
    upstream: null,
    pending: { client: [], upstream: [] },
    ended: { client: false, upstream: false },
    gone: { client: false, upstream: false },
    closeSent: { client: false, upstream: false },
    retry: { client: null, upstream: null },
    lingering: false,
    lingerSeconds,
    closed: false,
  };
}

function queue(conn: Conn, dest: Side, chunk: Uint8Array): void {
  // Bun may reuse the buffer handed to `data`, so anything we retain must be copied.
  conn.pending[dest].push(new Uint8Array(chunk));
  buffered += chunk.byteLength;
}

function dropQueue(conn: Conn, dest: Side): void {
  for (const chunk of conn.pending[dest]) buffered -= chunk.byteLength;
  conn.pending[dest].length = 0;
}

/** Write `chunk` toward `dest`, queueing only what the socket would not take. */
function forward(conn: Conn, dest: Side, chunk: Uint8Array): void {
  if (conn.closed || conn.gone[dest]) return; // destination is gone: nothing to hold on to
  const sock = conn[dest];
  if (!sock || conn.pending[dest].length > 0) {
    // Still connecting, or something is already waiting — queue to keep byte order.
    queue(conn, dest, chunk);
    conn[other(dest)]?.pause();
    if (sock) scheduleRetry(conn, dest);
    return;
  }
  const n = sock.write(chunk);
  if (n < 0) return destroy(conn);
  if (n < chunk.byteLength) {
    queue(conn, dest, chunk.subarray(n));
    conn[other(dest)]?.pause();
    scheduleRetry(conn, dest);
  }
}

/** Flush what is queued toward `dest`; resume the source once it is empty. */
function pump(conn: Conn, dest: Side): void {
  const sock = conn[dest];
  if (!sock) return;
  const q = conn.pending[dest];
  while (q.length > 0) {
    const chunk = q[0]!;
    const n = sock.write(chunk);
    if (n < 0) return destroy(conn);
    if (n < chunk.byteLength) {
      buffered -= n;
      q[0] = chunk.subarray(n);
      scheduleRetry(conn, dest); // still backpressured; the source stays paused
      return;
    }
    buffered -= chunk.byteLength;
    q.shift();
  }
  conn[other(dest)]?.resume();
  closeWhenDrained(conn, dest);
}

/** Close `dest` once its source has gone away and everything queued has been written. */
function closeWhenDrained(conn: Conn, dest: Side): void {
  const sock = conn[dest];
  if (!sock || conn.closeSent[dest]) return;
  if (!conn.gone[other(dest)] || conn.pending[dest].length > 0) return;
  conn.closeSent[dest] = true;
  sock.end();
}

function destroy(conn: Conn): void {
  if (conn.closed) return;
  conn.closed = true;
  cancelRetry(conn, "client");
  cancelRetry(conn, "upstream");
  dropQueue(conn, "client");
  dropQueue(conn, "upstream");
  conn.closeSent.client = true;
  conn.closeSent.upstream = true;
  conn.client?.end();
  conn.upstream?.end();
}

/** A FIN from one side. Recorded, never relayed — see the note at the top of the file. */
function onEnd(conn: Conn, side: Side): void {
  conn.ended[side] = true;
  pump(conn, other(side)); // deliver whatever is already queued the other way
  if (conn.ended[other(side)]) {
    destroy(conn); // both directions are finished
    return;
  }
  linger(conn);
}

/** Bound how long a half-finished pair may sit around when neither side ever closes. */
function linger(conn: Conn): void {
  conn.lingering = true;
  conn.client?.timeout(conn.lingerSeconds);
  conn.upstream?.timeout(conn.lingerSeconds);
}

/** Any traffic means the exchange is still alive: push the reaper back. */
function rearmLinger(conn: Conn): void {
  conn.client?.timeout(conn.lingerSeconds);
  conn.upstream?.timeout(conn.lingerSeconds);
}

function onClose(link: Link | undefined): void {
  if (!link) return;
  const { conn, side } = link;
  conn[side] = null;
  conn.gone[side] = true;
  conn.ended[side] = true;
  cancelRetry(conn, side);
  dropQueue(conn, side); // nothing can be written to a closed socket
  const peer = other(side);
  if (!conn[peer]) {
    conn.closed = true;
    return;
  }
  pump(conn, peer); // flush the last bytes, then close the peer
  closeWhenDrained(conn, peer);
}

function handlers(log: Logger): SocketHandler<SpliceSocketData> {
  return {
    data(socket, chunk) {
      const link = socket.data;
      if (!link) return;
      // Keep a lingering pair alive while it is still moving bytes.
      if (link.conn.lingering) rearmLinger(link.conn);
      forward(link.conn, other(link.side), chunk);
    },
    drain(socket) {
      const link = socket.data;
      if (!link) return;
      pump(link.conn, link.side);
    },
    end(socket) {
      const link = socket.data;
      if (!link) return;
      onEnd(link.conn, link.side);
    },
    close(socket) {
      onClose(socket.data);
    },
    timeout(socket) {
      const link = socket.data;
      if (!link) return;
      log("connection idle after a half-close; closing");
      destroy(link.conn);
    },
    error(socket, err) {
      log(`socket error: ${err.message}`);
      if (socket.data) destroy(socket.data.conn);
    },
    connectError() {
      // Handled where Bun.connect is awaited; declared so Bun does not reject globally.
    },
  };
}

export interface SpliceOptions {
  /** Read per connection, so a routes reload retargets without rebinding the listener. */
  targetPort: () => number;
  targetHost?: string;
  /**
   * Seconds a half-closed, idle connection may sit before it is dropped. Bun cannot tell a
   * client that half-closed from one that vanished, so this is what reaps the second case.
   */
  lingerSeconds?: number;
  log: Logger;
}

/** Socket handlers for a listener: every accepted connection is spliced to the target. */
export function spliceHandlers(opts: SpliceOptions): SocketHandler<SpliceSocketData> {
  const base = handlers(opts.log);
  const host = opts.targetHost ?? "127.0.0.1";
  const lingerSeconds = opts.lingerSeconds ?? 15;
  return {
    ...base,
    open(client) {
      const conn = newConn(lingerSeconds);
      client.data = { conn, side: "client" };
      conn.client = client;
      client.pause(); // stay quiet until the upstream socket exists

      const port = opts.targetPort();
      Bun.connect<SpliceSocketData>({
        hostname: host,
        port,
        // No allowHalfOpen here: an upstream close must reach the client immediately.
        data: { conn, side: "upstream" },
        socket: {
          ...base,
          open(upstream) {
            if (conn.closed || !conn.client) {
              upstream.end();
              return;
            }
            conn.upstream = upstream;
            pump(conn, "upstream");
            conn.client?.resume();
          },
        },
      }).catch((err: Error) => {
        opts.log(`connect to ${host}:${port} failed: ${err.message}`);
        conn.gone.upstream = true;
        conn.ended.upstream = true;
        destroy(conn);
      });
    },
  };
}
