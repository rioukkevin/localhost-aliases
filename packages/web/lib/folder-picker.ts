/**
 * Native folder selection, and the validation every folder path goes through.
 *
 * Two ways in, one way out: the macOS `choose folder` dialog (shelled through
 * osascript) and a typed absolute path (the fallback for anyone who cannot use
 * the dialog — screen readers, remote sessions, a wedged WindowServer). Both end
 * at `resolveFolderPath()`, so a path that reaches the client is always an
 * absolute POSIX path that exists and is a directory.
 *
 * Everything that can be reasoned about without a Mac attached is a pure
 * function here (`posixCandidates`, `classifyOsascript`); the process spawn is
 * injected so the timeout and cancel paths are unit-testable with osascript
 * stubbed.
 */
import { mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ValidationError } from "@localhost-aliases/core";

export const PICK_FOLDER_TIMEOUT_MS = 60_000;

/** Server-controlled, never client-supplied: it is interpolated into a script. */
const PROMPT = "Choose a project folder";

/**
 * `tell me to activate` is load-bearing. Without it the dialog opens behind the
 * browser and the user sees nothing happen. It activates the osascript process
 * itself rather than sending an Apple event to System Events, which (a) needs no
 * Automation/TCC consent and (b) keeps the dialog owned by the process we can
 * kill — killing osascript takes the dialog down with it.
 *
 * `POSIX path of` does the HFS -> POSIX conversion in the one place that knows
 * the volume layout. `posixCandidates()` below is the fallback for the day this
 * returns a colon path anyway.
 */
const CHOOSE_FOLDER_SCRIPT = [
  "tell me to activate",
  `set chosen to choose folder with prompt "${PROMPT}"`,
  "return POSIX path of chosen",
].join("\n");

export type PickFolderResult = { path: string } | { cancelled: true };

/** A failure worth showing the user verbatim, with the status it deserves. */
export class PickFolderError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "PickFolderError";
    this.status = status;
  }
}

export interface OsascriptResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type OsascriptRunner = (script: string, timeoutMs: number) => Promise<OsascriptResult>;

export interface PickFolderDeps {
  run?: OsascriptRunner;
  isDirectory?: (path: string) => Promise<boolean>;
  timeoutMs?: number;
  /** Defaults to LA_FOLDER_PICKER; "stub" | "cancel" | "error" bypass the dialog. */
  mode?: string;
  /** Defaults to LA_FOLDER_PICKER_PATH, then a fixed directory under $TMPDIR. */
  stubPath?: string;
}

// ---------------------------------------------------------------------------
// Pure path logic
// ---------------------------------------------------------------------------

/** Strips the trailing separator `POSIX path of` adds to folders, keeping "/". */
export function stripTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Every absolute POSIX path a raw osascript answer could mean, best first.
 *
 * Normally the answer is already POSIX (`/Users/kevin/Café Ø/`) and there is one
 * candidate. An HFS colon path (`Macintosh HD:Users:kevin:Café Ø:`) names its
 * volume first, and which POSIX root that volume is mounted at is not knowable
 * from the string: the boot volume is `/`, anything else is `/Volumes/<name>`.
 * So both are returned and the caller picks the one that is a real directory.
 */
export function posixCandidates(raw: string): string[] {
  const value = raw.trim();
  if (value === "") return [];
  if (value.startsWith("/")) return [stripTrailingSlash(value)];
  if (!value.includes(":")) return [];

  const parts = value.split(":");
  const volume = parts[0] ?? "";
  const rest = parts.slice(1).filter((part) => part !== "");
  const fromRoot = stripTrailingSlash(`/${rest.join("/")}`);
  const fromVolumes = stripTrailingSlash(`/Volumes/${volume}/${rest.join("/")}`);
  return volume === "" ? [fromRoot] : [fromRoot, fromVolumes];
}

/** AppleScript's "user cancelled" is error -128, and it exits non-zero for it. */
export function isCancelled(result: OsascriptResult): boolean {
  return /\(-128\)/.test(result.stderr) || /user cancell?ed/i.test(result.stderr);
}

export type OsascriptOutcome =
  | { kind: "ok"; raw: string }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

/** The whole decision table for what osascript just did. Pure, so it is tested. */
export function classifyOsascript(result: OsascriptResult): OsascriptOutcome {
  if (result.timedOut) return { kind: "timeout" };
  if (isCancelled(result)) return { kind: "cancelled" };
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").pop() ?? "";
    return { kind: "failed", message: detail === "" ? `osascript exited ${result.code}` : detail };
  }
  if (result.stdout.trim() === "") return { kind: "failed", message: "osascript returned no path" };
  return { kind: "ok", raw: result.stdout };
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

async function isDirectoryOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turns a raw answer (from the dialog or from the user's keyboard) into an
 * absolute POSIX path that exists, or throws. `field` decides whose fault it is:
 * a typed path is a 400 with a field-level issue, a dialog answer is a 500.
 */
async function firstRealDirectory(
  candidates: string[],
  isDirectory: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new ValidationError([{ field: "path", message }]);
}

/**
 * Validates a hand-typed folder path. The server is the authority: the browser
 * cannot see the filesystem, and the client-side check is only a prediction.
 */
export async function resolveManualPath(
  raw: string,
  isDirectory: (path: string) => Promise<boolean> = isDirectoryOnDisk,
): Promise<string> {
  const value = raw.trim();
  if (value === "") fail("is required");
  if (value.includes("\0")) fail("contains an invalid character");

  const expanded =
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) fail("must be an absolute path, starting with /");

  // resolve() folds away "..", "." and trailing slashes so two spellings of the
  // same folder cannot become two different projects.
  const normalized = stripTrailingSlash(resolve(expanded));
  if (!(await isDirectory(normalized))) fail("does not exist, or is not a folder");
  return normalized;
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * Runs a child process and guarantees it cannot outlive `timeoutMs`.
 *
 * Generic in the argv so the timeout/kill path is testable without osascript.
 *
 * The kill targets this child's own pid — never a name or a pattern — so nothing
 * else on the machine can be hit. SIGKILL rather than SIGTERM because the point
 * is that the request is already abandoned; the dialog belongs to this process,
 * so it disappears with it.
 */
export async function runProcess(argv: string[], timeoutMs: number): Promise<OsascriptResult> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

  const finished = (async (): Promise<OsascriptResult> => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr, timedOut: false };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolveTimer) => {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolveTimer(null);
    }, timeoutMs);
  });

  try {
    const winner = await Promise.race([finished, expired]);
    if (winner !== null) return winner;
    /*
     * Deliberately NOT awaiting the output after a timeout. Killing the child
     * does not always close the pipes — anything it spawned inherits them and
     * keeps stdout open — so waiting for EOF here would reintroduce exactly the
     * hang this deadline exists to prevent. (Verified: a killed `sh` whose
     * `sleep` outlived it held the read for the full sleep.) The output of an
     * abandoned dialog is worthless anyway.
     */
    proc.stdout.cancel().catch(() => {});
    proc.stderr.cancel().catch(() => {});
    finished.catch(() => {});
    return { code: 137, stdout: "", stderr: "", timedOut: true };
  } finally {
    clearTimeout(timer);
  }
}

const spawnOsascript: OsascriptRunner = (script, timeoutMs) =>
  runProcess(["/usr/bin/osascript", "-e", script], timeoutMs);

/** Fixed directory returned by LA_FOLDER_PICKER=stub. Created so it validates. */
async function stubFolder(explicit?: string): Promise<string> {
  const path = explicit ?? process.env.LA_FOLDER_PICKER_PATH ?? join(tmpdir(), "la-picked-folder");
  await mkdir(path, { recursive: true });
  return stripTrailingSlash(resolve(path));
}

/**
 * Opens the native folder chooser. Never throws for a cancel — that is a normal
 * outcome, not an error — and never blocks longer than `timeoutMs`.
 */
export async function pickFolder(deps: PickFolderDeps = {}): Promise<PickFolderResult> {
  const isDirectory = deps.isDirectory ?? isDirectoryOnDisk;
  const mode = deps.mode ?? process.env.LA_FOLDER_PICKER ?? "";

  // Test/CI modes. Checked before anything is spawned: a test must never be able
  // to open a real dialog on someone's screen.
  if (mode === "stub") return { path: await stubFolder(deps.stubPath) };
  if (mode === "cancel") return { cancelled: true };
  if (mode === "error") throw new PickFolderError("The folder dialog is stubbed to fail.", 500);

  if (process.platform !== "darwin") {
    throw new PickFolderError("The folder dialog is only available on macOS. Type the path instead.", 501);
  }

  const run = deps.run ?? spawnOsascript;
  const result = await run(CHOOSE_FOLDER_SCRIPT, deps.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS);
  const outcome = classifyOsascript(result);

  switch (outcome.kind) {
    case "cancelled":
      return { cancelled: true };
    case "timeout":
      throw new PickFolderError(
        "The folder dialog was still open after 60 seconds, so it was closed. Try again, or type the path.",
        504,
      );
    case "failed":
      throw new PickFolderError(`The folder dialog failed: ${outcome.message}`, 500);
    case "ok": {
      const path = await firstRealDirectory(posixCandidates(outcome.raw), isDirectory);
      if (path === null) {
        throw new PickFolderError(
          `The chosen folder could not be resolved to a real directory (${outcome.raw.trim()}).`,
          500,
        );
      }
      return { path };
    }
  }
}
