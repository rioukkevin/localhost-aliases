/**
 * Watching one file that is replaced by rename.
 *
 * Both files this process cares about — routes.json and desired-state.json — are written
 * atomically (temp file + rename), which breaks an fs.watch on the file itself: the watch
 * follows the inode, and the inode is thrown away. So the DIRECTORY is watched and events
 * are filtered by name, with a slow mtime poll underneath for anything the watcher misses
 * (network volumes, a missed rename, a watcher that errored out).
 *
 * Extracted because the agent needs exactly the same behaviour the forwarder already had,
 * and two copies of "why fs.watch is not enough" would drift.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { type Logger, silentLog } from "./log.ts";

export interface FileWatchOptions {
  path: string;
  /** Called (debounced) when the file may have changed. */
  onChange: () => void;
  /** Called on a poll that found the file unchanged. Lets a caller retry its own failures. */
  onUnchanged?: () => void;
  /** Fallback poll interval. */
  pollMs?: number;
  /** Coalesce window: one atomic rewrite can fire several events. */
  debounceMs?: number;
  log?: Logger;
}

export class FileWatcher {
  private readonly path: string;
  private readonly onChange: () => void;
  private readonly onUnchanged: (() => void) | undefined;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly log: Logger;

  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private lastSeen = "";
  private stopped = false;

  constructor(opts: FileWatchOptions) {
    this.path = opts.path;
    this.onChange = opts.onChange;
    this.onUnchanged = opts.onUnchanged;
    this.pollMs = opts.pollMs ?? 2_000;
    this.debounceMs = opts.debounceMs ?? 40;
    this.log = opts.log ?? silentLog;
  }

  start(): void {
    const dir = dirname(this.path);
    const name = basename(this.path);
    try {
      this.watcher = fsWatch(dir, (_event, filename) => {
        if (filename && basename(filename) !== name) return;
        this.schedule();
      });
      this.watcher.on("error", (err) => this.log(`watcher error on ${dir}: ${describe(err)}`));
    } catch (err) {
      this.log(`cannot watch ${dir}: ${describe(err)}; falling back to polling`);
    }
    this.poll = setInterval(() => void this.check(), this.pollMs);
  }

  /**
   * Record the file's stamp before the caller reads it, so the next poll only reports a
   * change that happened after the read. Without this the read itself looks like a change.
   */
  async prime(): Promise<void> {
    try {
      const info = await stat(this.path);
      this.lastSeen = `${info.mtimeMs}:${info.size}`;
    } catch {
      this.lastSeen = "";
    }
  }

  /** Ask for a debounced onChange, as if the file had just been written. */
  schedule(): void {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.onChange();
    }, this.debounceMs);
  }

  private async check(): Promise<void> {
    try {
      const info = await stat(this.path);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === this.lastSeen) {
        this.onUnchanged?.();
        return;
      }
      this.lastSeen = stamp;
      this.schedule();
    } catch {
      // Gone. Report it once, then stay quiet until it comes back.
      if (this.lastSeen === "") return;
      this.lastSeen = "";
      this.schedule();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

export function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code && e?.message) return `${e.code}: ${e.message}`;
  if (e?.code) return e.code;
  return e?.message ?? String(err);
}
