/**
 * One server per build directory.
 *
 * Next.js keeps its compiler output, its manifests and its dev-time page cache in `distDir`.
 * Two servers pointed at the same directory overwrite each other's manifests and wedge with
 * no error output at all — the symptom is a server that simply never answers. It is a silent
 * failure that costs hours, so it is turned into a loud one here, from `next.config.ts`:
 * that file is loaded before Next compiles anything, so throwing there aborts the boot
 * immediately instead of leaving a half-started server behind.
 *
 * `LA_NEXT_DIST_DIR` is the escape hatch: a test (or a second dev server) gets its own build
 * tree and therefore its own lock, and can never destroy the production `.next` build.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";

interface Holder {
  pid: number;
  port: string;
}

/** Build output directory, relative to packages/web. Read late so tests can set it. */
export function distDir(): string {
  const raw = process.env.LA_NEXT_DIST_DIR?.trim();
  return raw === undefined || raw === "" ? ".next" : raw;
}

/** The port this server was asked to serve; also the identity of the server tree. */
export function dashboardPort(): string {
  const raw = process.env.LA_DASHBOARD_PORT?.trim();
  return raw === undefined || raw === "" ? "7788" : raw;
}

/**
 * Beside the build directory, never inside it: `next dev` wipes `distDir` on boot, which
 * would delete the lock a few milliseconds after it was taken.
 */
function lockPath(): string {
  return `${distDir()}.lock`;
}

/** `kill(pid, 0)` signals nothing; it only asks whether the process is still there. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still a live holder.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live process holding `path`, or null when it is free (missing, stale, or ours). */
function holder(path: string): Holder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
    if (pid <= 0 || pid === process.pid || !isRunning(pid)) return null;
    return { pid, port: String(parsed.port ?? "?") };
  } catch {
    return null; // missing or corrupt: nobody holds it
  }
}

/**
 * The message to abort with when someone else owns `distDir`, or null when it is ours.
 *
 * A holder on the *same* port is our own server tree: `next dev` loads this config once in
 * the CLI process and again in the server process it spawns, and both must be allowed in.
 * Two servers on the same port cannot exist anyway — the second one fails to bind.
 */
export function conflictingServer(): string | null {
  const current = holder(lockPath());
  if (current === null || current.port === dashboardPort()) return null;
  return (
    `another dashboard (pid ${current.pid}, port ${current.port}) is already using ` +
    `${distDir()}/. Two Next.js servers sharing one build directory corrupt each other's ` +
    `manifests and then hang with no error at all. Stop that server, or give this one its ` +
    `own build tree with LA_NEXT_DIST_DIR=<dir>.`
  );
}

/** Records this process as the owner and arranges for the record to go away with it. */
export function claimDistDir(): void {
  // Captured once: the release path must be the file we wrote, whatever the environment
  // or the working directory looks like by the time this process exits.
  const path = lockPath();
  writeFileSync(
    path,
    JSON.stringify({ pid: process.pid, port: dashboardPort(), startedAt: new Date().toISOString() }),
  );

  const release = () => {
    // `holder()` is null exactly when the record is ours (or already gone): never delete a
    // later owner's lock on the way out.
    if (holder(path) === null) rmSync(path, { force: true });
  };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
}
