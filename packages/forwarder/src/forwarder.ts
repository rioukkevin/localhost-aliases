/**
 * Owns the listeners. One listener per `ip:listenPort`; the target port is read per
 * connection from the live route object, so changing only a port rebinds nothing —
 * which is what lets the app change a port without an admin prompt.
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { TCPSocketListener } from "bun";
import type { ForwarderStatus, Route } from "@localhost-aliases/core/types";
import { forwarderStatusPath, routesPath } from "@localhost-aliases/core/paths";
import { type Logger, stderrLog } from "./log.ts";
import { readRoutes, routeKey } from "./routes.ts";
import { type SpliceSocketData, spliceHandlers } from "./splice.ts";
import { clearStatus, writeStatus } from "./status.ts";

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
  log?: Logger;
}

export class Forwarder {
  private readonly routesFile: string;
  private readonly statusFile: string;
  private readonly targetHost: string;
  private readonly pollMs: number;
  private readonly lingerSeconds: number | undefined;
  private readonly log: Logger;

  private readonly bound = new Map<string, Bound>();
  private failures: ForwarderStatus["failures"] = [];
  private readonly startedAt = new Date().toISOString();

  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private lastSeen = "";
  private reloading: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: ForwarderOptions = {}) {
    this.routesFile = opts.routesFile ?? routesPath();
    this.statusFile = opts.statusFile ?? forwarderStatusPath();
    this.targetHost = opts.targetHost ?? "127.0.0.1";
    this.pollMs = opts.pollMs ?? 2_000;
    this.lingerSeconds = opts.lingerSeconds;
    this.log = opts.log ?? stderrLog;
  }

  /** Bind what routes.json asks for, publish status, then watch the file. */
  async start(): Promise<void> {
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
    this.reloading = this.reloading.then(() => this.reconcile()).catch((err: Error) => {
      this.log(`reload failed: ${err.message}`);
    });
    return this.reloading;
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    await this.primeStamp(); // read the stamp first: a write during the read is caught next poll
    const { routes, errors } = await readRoutes(this.routesFile);
    for (const error of errors) this.log(error);

    // A corrupt or truncated routes file must not tear down what is already working.
    if (routes.length === 0 && errors.length > 0 && this.bound.size > 0) {
      this.log("keeping the current routes: the routes file is unusable");
      this.failures = errors.map((error) => ({ route: fileRoute(this.routesFile), error }));
      await this.publish();
      return;
    }

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

  /** One route may never take the others down: a bind error is recorded, not thrown. */
  private bind(key: string, route: Route): string | null {
    // `live` is what the handlers read, and what a reload mutates in place.
    const live: Route = { ...route };
    let listener: TCPSocketListener<SpliceSocketData>;
    try {
      listener = Bun.listen<SpliceSocketData>({
        hostname: route.ip,
        port: route.listenPort,
        // Survive a client's FIN so its reply can still be written back — see splice.ts.
        allowHalfOpen: true,
        data: undefined,
        socket: spliceHandlers({
          targetPort: () => live.targetPort,
          targetHost: this.targetHost,
          lingerSeconds: this.lingerSeconds,
          log: this.log,
        }),
      });
    } catch (err) {
      const reason = describe(err);
      this.log(`cannot bind ${key} (${route.hostname}): ${reason}`);
      return reason;
    }
    this.bound.set(key, { route: live, listener });
    this.log(`listening on ${key} -> ${this.targetHost}:${route.targetPort} (${route.hostname})`);
    return null;
  }

  private async publish(): Promise<void> {
    try {
      await writeStatus(this.statusFile, this.status);
    } catch (err) {
      this.log(`could not write status: ${describe(err)}`);
    }
  }

  /**
   * routes.json is replaced by rename, which breaks a watch on the file itself, so we watch
   * the directory. A slow mtime poll covers anything the watcher misses.
   */
  private watch(): void {
    const dir = dirname(this.routesFile);
    const name = basename(this.routesFile);
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename && basename(filename) !== name) return;
        this.schedule();
      });
      this.watcher.on("error", (err) => this.log(`routes watcher error: ${describe(err)}`));
    } catch (err) {
      this.log(`cannot watch ${dir}: ${describe(err)}; falling back to polling`);
    }
    this.poll = setInterval(() => void this.checkFile(), this.pollMs);
  }

  /** Record the file's stamp before the first read, so the poll only reports real changes. */
  private async primeStamp(): Promise<void> {
    try {
      const info = await stat(this.routesFile);
      this.lastSeen = `${info.mtimeMs}:${info.size}`;
    } catch {
      this.lastSeen = "";
    }
  }

  private async checkFile(): Promise<void> {
    try {
      const info = await stat(this.routesFile);
      const stamp = `${info.mtimeMs}:${info.size}`;
      // Unchanged file, but something is still broken: retry the binds that failed. A port
      // held by another process frees up without anyone editing routes.json.
      if (stamp === this.lastSeen) {
        if (this.failures.length > 0) this.schedule();
        return;
      }
      this.lastSeen = stamp;
      this.schedule();
    } catch {
      if (this.lastSeen === "") return;
      this.lastSeen = "";
      this.schedule();
    }
  }

  /** Coalesce bursts: an atomic rewrite can fire several events. */
  private schedule(): void {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.reload();
    }, 40);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    this.watcher?.close();
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

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code && e?.message) return `${e.code}: ${e.message}`;
  if (e?.code) return e.code;
  return e?.message ?? String(err);
}
