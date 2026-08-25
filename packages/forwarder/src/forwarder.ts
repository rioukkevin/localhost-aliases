/**
 * Owns the listeners. One listener per `ip:listenPort`; the target port is read per
 * connection from the live route object, so changing only a port rebinds nothing —
 * which is what lets the app change a port without an admin prompt.
 *
 * Routes reach it two ways, and only ever one at a time:
 *   - it watches routes.json itself (the plain forwarder, and every existing test), or
 *   - the root agent hands it a validated list (`setRoutes`) after reconciling the system.
 * When the agent is driving, file watching is off: two sources of truth for what root is
 * listening on is exactly the kind of thing that ends up bound to the wrong port.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { TCPSocketListener } from "bun";
import type { ForwarderStatus, Route } from "@localhost-aliases/core/types";
import { aliasCertPath, aliasKeyPath, forwarderStatusPath, routesPath } from "@localhost-aliases/core/paths";
import { type Logger, stderrLog } from "./log.ts";
import { readRoutes, routeKey } from "./routes.ts";
import { type SpliceSocketData, spliceHandlers } from "./splice.ts";
import { clearStatus, writeStatus } from "./status.ts";
import { FileWatcher, describe } from "./watch.ts";

interface Bound {
  /** Mutated in place on reload; the splice handlers read it per connection. */
  route: Route;
  listener: TCPSocketListener<SpliceSocketData>;
}

export interface ForwarderOptions {
  routesFile?: string;
  statusFile?: string;
  /** Where every route forwards to. Only overridden in tests. */
  targetHost?: string;
  /** Fallback poll for the routes file, in case fs.watch misses a rename. */
  pollMs?: number;
  /** Seconds a half-closed, idle connection may sit before it is dropped. */
  lingerSeconds?: number;
  /**
   * The certificate presented on TLS routes. One pair covers every alias (each hostname is a
   * SAN), so a listener needs no knowledge beyond "am I a TLS route".
   */
  certPath?: string;
  keyPath?: string;
  /**
   * Read routes.json and watch it. False when the root agent owns the routes: it has
   * already validated them and hands them over directly.
   */
  watchRoutesFile?: boolean;
  /**
   * Serve the offline page when the upstream refuses a connection. On by default: a dev
   * server that is not running is the single most common thing a user hits.
   */
  offlinePage?: boolean;
  log?: Logger;
}

export class Forwarder {
  private readonly routesFile: string;
  private readonly statusFile: string;
  private readonly targetHost: string;
  private readonly pollMs: number;
  private readonly lingerSeconds: number | undefined;
  private readonly certPath: string;
  /** Cleared on reload so a re-issued certificate is picked up. */
  private tlsCache: { cert: string; key: string } | null = null;
  private readonly keyPath: string;
  private readonly watchRoutesFile: boolean;
  private readonly offlinePage: boolean;
  private readonly log: Logger;

  private readonly bound = new Map<string, Bound>();
  private failures: ForwarderStatus["failures"] = [];
  private readonly startedAt = new Date().toISOString();

  private watcher: FileWatcher | null = null;
  private reloading: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: ForwarderOptions = {}) {
    this.routesFile = opts.routesFile ?? routesPath();
    this.statusFile = opts.statusFile ?? forwarderStatusPath();
    this.targetHost = opts.targetHost ?? "127.0.0.1";
    this.pollMs = opts.pollMs ?? 2_000;
    this.lingerSeconds = opts.lingerSeconds;
    this.certPath = opts.certPath ?? aliasCertPath();
    this.keyPath = opts.keyPath ?? aliasKeyPath();
    this.watchRoutesFile = opts.watchRoutesFile ?? true;
    this.offlinePage = opts.offlinePage ?? true;
    this.log = opts.log ?? stderrLog;
  }

  /** Bind what routes.json asks for, publish status, then watch the file. */
  async start(): Promise<void> {
    if (!this.watchRoutesFile) {
      // Nothing to bind yet; the agent calls setRoutes once it has validated the state.
      await this.publish();
      return;
    }
    await this.reload();
    this.watch();
  }

  get status(): ForwarderStatus {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      routes: [...this.bound.values()].map((b) => ({ ...b.route })),
      failures: this.failures.map((f) => ({ route: { ...f.route }, error: f.error })),
    };
  }

  /** Serialized so two file events cannot interleave two reconciles. */
  reload(): Promise<void> {
    this.reloading = this.reloading.then(() => this.reconcileFromFile()).catch((err: Error) => {
      this.log(`reload failed: ${err.message}`);
    });
    return this.reloading;
  }

  /**
   * Bind exactly these routes. The caller has already validated them — this is the agent's
   * entry point, and it goes through the same serialization as a file reload.
   */
  setRoutes(routes: readonly Route[]): Promise<void> {
    this.reloading = this.reloading
      .then(() => this.applyRoutes(routes.map((r) => ({ ...r })), []))
      .catch((err: Error) => {
        this.log(`applying routes failed: ${err.message}`);
      });
    return this.reloading;
  }

  private async reconcileFromFile(): Promise<void> {
    if (this.stopped) return;
    // Read the stamp first: a write during the read is caught by the next poll.
    await this.watcher?.prime();
    const { routes, errors } = await readRoutes(this.routesFile);
    for (const error of errors) this.log(error);

    // A corrupt or truncated routes file must not tear down what is already working.
    if (routes.length === 0 && errors.length > 0 && this.bound.size > 0) {
      this.log("keeping the current routes: the routes file is unusable");
      this.failures = errors.map((error) => ({ route: fileRoute(this.routesFile), error }));
      await this.publish();
      return;
    }
    await this.applyRoutes(routes, errors);
  }

  private async applyRoutes(routes: readonly Route[], errors: readonly string[]): Promise<void> {
    if (this.stopped) return;
    // The certificate may have been re-issued since the last apply.
    this.tlsCache = null;
    const wanted = new Map(routes.map((r) => [routeKey(r), r]));
    const failures: ForwarderStatus["failures"] = [];

    for (const [key, entry] of [...this.bound]) {
      const want = wanted.get(key);
      if (!want) {
        entry.listener.stop(true);
        this.bound.delete(key);
        this.log(`dropped ${key} (${entry.route.hostname})`);
        continue;
      }
      if (entry.route.targetPort !== want.targetPort || entry.route.hostname !== want.hostname) {
        this.log(
          `retargeted ${key} -> ${this.targetHost}:${want.targetPort} (${want.hostname}), listener kept`,
        );
      }
      // Mutate in place: the listener and its open connections stay exactly as they are.
      entry.route.targetPort = want.targetPort;
      entry.route.hostname = want.hostname;
      entry.route.hint = want.hint;
    }

    for (const [key, want] of wanted) {
      if (this.bound.has(key)) continue;
      const failure = this.bind(key, want);
      if (failure) failures.push({ route: { ...want }, error: failure });
    }

    // Parse errors are not bind errors, but the UI has no other way to learn the file is bad.
    for (const error of errors) failures.push({ route: fileRoute(this.routesFile), error });
    this.failures = failures;
    await this.publish();
  }

  /**
   * The certificate pair, read once and reused by every TLS route. Throws if unreadable — the
   * caller is inside bind()'s try, so that becomes a recorded per-route failure.
   */
  private tlsMaterial(): { cert: string; key: string } {
    if (!this.tlsCache) {
      this.tlsCache = {
        cert: readFileSync(this.certPath, "utf8"),
        key: readFileSync(this.keyPath, "utf8"),
      };
    }
    return this.tlsCache;
  }

  /** One route may never take the others down: a bind error is recorded, not thrown. */
  private bind(key: string, route: Route): string | null {
    // `live` is what the handlers read, and what a reload mutates in place.
    const live: Route = { ...route };
    let listener: TCPSocketListener<SpliceSocketData>;
    try {
      listener = Bun.listen<SpliceSocketData>({
        hostname: route.ip,
        port: route.listenPort,
        // TLS terminates here and the plaintext is spliced onward unchanged.
        //
        // The material is read EAGERLY, before binding, rather than handed over as Bun.file.
        // A lazy handle defers the read to the first connection, which puts a file read inside
        // the first handshake and — worse — turns a missing certificate into an intermittent
        // hang on someone's first request instead of a bind failure we can report. Reading it
        // here means a bad certificate fails this one route loudly, like a port already in use.
        ...(route.tls ? { tls: this.tlsMaterial() } : {}),
        // Survive a client's FIN so its reply can still be written back — see splice.ts.
        allowHalfOpen: true,
        data: undefined,
        socket: spliceHandlers({
          targetPort: () => live.targetPort,
          targetHost: this.targetHost,
          lingerSeconds: this.lingerSeconds,
          offlineRoute: this.offlinePage ? () => live : undefined,
          log: this.log,
        }),
      });
    } catch (err) {
      const reason = describe(err);
      this.log(`cannot bind ${key} (${route.hostname}): ${reason}`);
      return reason;
    }
    this.bound.set(key, { route: live, listener });
    this.log(`listening on ${key}${route.tls ? " (tls)" : ""} -> ${this.targetHost}:${route.targetPort} (${route.hostname})`);
    return null;
  }

  private async publish(): Promise<void> {
    try {
      await writeStatus(this.statusFile, this.status);
    } catch (err) {
      this.log(`could not write status: ${describe(err)}`);
    }
  }

  private watch(): void {
    this.watcher = new FileWatcher({
      path: this.routesFile,
      pollMs: this.pollMs,
      log: this.log,
      onChange: () => void this.reload(),
      // Unchanged file, but something is still broken: retry the binds that failed. A port
      // held by another process frees up without anyone editing routes.json.
      onUnchanged: () => {
        if (this.failures.length > 0) this.watcher?.schedule();
      },
    });
    this.watcher.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.stop();
    this.watcher = null;
    for (const [key, entry] of this.bound) {
      entry.listener.stop(true);
      this.bound.delete(key);
    }
    await this.reloading.catch(() => {});
    await clearStatus(this.statusFile);
  }
}

function fileRoute(path: string): Route {
  return { ip: "", listenPort: 0, targetPort: 0, hostname: basename(path) };
}
