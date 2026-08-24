/**
 * The one place localhost-aliases asks for a password.
 *
 * Everything privileged goes through `runPrivileged`, which raises exactly one macOS
 * admin prompt via `osascript … with administrator privileges` and returns a typed
 * result. A cancelled prompt is a normal outcome, not an exception.
 *
 * Two layers of escaping stand between a filesystem path and root:
 *   1. `shellQuote` — the command is run by /bin/sh, so every argument is single-quoted.
 *   2. `escapeAppleScriptString` — that command is then a string literal inside AppleScript.
 * Both are pure and tested against adversarial paths; a quote, a space, a `$(…)` or a
 * newline in a path must not be able to become code.
 *
 * Nothing here ever prints the command it runs.
 */

export interface PrivilegedRequest {
  /** Program and arguments. argv[0] is the program; nothing is interpreted by a shell. */
  argv: readonly string[];
  /** Environment prepended as NAME=value assignments — as root there is no useful inherited env. */
  env?: Readonly<Record<string, string>>;
  /** Text shown above the password field. Keep it short and honest. */
  prompt?: string;
}

export interface PrivilegedResult {
  /** True only when the script exited 0. */
  ok: boolean;
  /** True when the user dismissed the password dialog (AppleScript error -128). */
  cancelled: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The script's `LA_RESULT key=value …` line, parsed. Null when it printed none. */
  summary: Record<string, string> | null;
  /** The script's `LA_ERROR step=… message=…` line, parsed. Null when it printed none. */
  error: { step: string; message: string } | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
/** Injectable for tests. The default runs osascript. */
export type Exec = (argv: readonly string[]) => Promise<ExecResult>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * POSIX single-quoting: inside '…' every byte is literal, so the only case to handle
 * is the quote itself. `it's` becomes `'it'\''s'`.
 */
export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Refusing to build a command from a value containing a NUL byte.");
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** `NAME='value' … 'program' 'arg' …`, safe to hand to /bin/sh. */
export function buildShellCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
): string {
  if (argv.length === 0) throw new Error("Refusing to build an empty privileged command.");
  const parts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    // An attacker-chosen name would otherwise become a second command.
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}.`);
    parts.push(`${name}=${shellQuote(value)}`);
  }
  for (const arg of argv) parts.push(shellQuote(arg));
  return parts.join(" ");
}

/**
 * AppleScript string literals understand \\ \" \n \r \t and nothing else, so those five
 * are the whole job. Anything else (including UTF-8) is passed through untouched.
 */
export function escapeAppleScriptString(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: out += ch;
    }
  }
  return out;
}

/** The single AppleScript statement passed to `osascript -e`. */
export function buildAppleScript(command: string, prompt?: string): string {
  const script = `do shell script "${escapeAppleScriptString(command)}"`;
  const withPrompt = prompt ? `${script} with prompt "${escapeAppleScriptString(prompt)}"` : script;
  return `${withPrompt} with administrator privileges`;
}

/** The last `LA_RESULT …` line, as key/value pairs. */
export function parseSummary(stdout: string): Record<string, string> | null {
  const line = lastLineStartingWith(stdout, "LA_RESULT");
  if (line === null) return null;
  const out: Record<string, string> = {};
  for (const token of line.slice("LA_RESULT".length).trim().split(/\s+/)) {
    if (token === "") continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

/**
 * The last `LA_ERROR step=… message=…` line. It is on stderr because AppleScript's
 * `do shell script` throws away stdout whenever the exit code is non-zero.
 */
export function parseError(stderr: string): { step: string; message: string } | null {
  const line = lastLineStartingWith(stderr, "LA_ERROR");
  if (line === null) return null;
  const step = /\bstep=(\S+)/.exec(line)?.[1] ?? "unknown";
  const at = line.indexOf("message=");
  const message = at === -1 ? line.slice("LA_ERROR".length).trim() : line.slice(at + "message=".length).trim();
  return { step, message };
}

/** -128 is the AppleScript code for "the user dismissed the dialog". */
export function isCancellation(exitCode: number, stderr: string): boolean {
  if (exitCode === 0) return false;
  return /\(-128\)/.test(stderr) || /User canceled/i.test(stderr);
}

function lastLineStartingWith(text: string, prefix: string): string | null {
  let found: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(prefix)) found = line;
  }
  return found;
}

const osascriptExec: Exec = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * Raise one admin prompt and run `request.argv` as root.
 *
 * Never throws for anything the user did: a cancelled prompt, a failing script and a
 * missing osascript all come back as a result. It throws only when the request itself
 * cannot be represented safely (empty argv, a bad env name, a NUL byte).
 */
export async function runPrivileged(
  request: PrivilegedRequest,
  options: { exec?: Exec } = {},
): Promise<PrivilegedResult> {
  const command = buildShellCommand(request.argv, request.env ?? {});
  const script = buildAppleScript(command, request.prompt);
  const exec = options.exec ?? osascriptExec;

  let raw: ExecResult;
  try {
    raw = await exec(["osascript", "-e", script]);
  } catch (cause) {
    // Deliberately not including `script`: it is the whole command line.
    return {
      ok: false,
      cancelled: false,
      exitCode: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : String(cause),
      summary: null,
      error: { step: "osascript", message: "Could not run osascript." },
    };
  }

  const cancelled = isCancellation(raw.exitCode, raw.stderr);
  return {
    ok: raw.exitCode === 0,
    cancelled,
    exitCode: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
    summary: parseSummary(raw.stdout),
    error: cancelled ? null : parseError(raw.stderr),
  };
}

// ---------------------------------------------------------------------------
// Command builders — so callers never hand-assemble an argv for root.
// ---------------------------------------------------------------------------

export interface PrivilegedEnvInput {
  /** ~/.config/localhost-aliases. Required: as root, HOME is /var/root. */
  configDir: string;
  /** Absolute path to the forwarder binary. */
  forwarder?: string;
  hostsPath?: string;
  logDir?: string;
  /** "uid:gid" of the real user, so files root creates are handed back. */
  owner?: string;
  /** Every loopback IP this install has ever allocated; restricts lo0 removals. */
  managedIps?: readonly string[];
}

export function privilegedEnv(input: PrivilegedEnvInput): Record<string, string> {
  const env: Record<string, string> = { LA_CONFIG_DIR: input.configDir };
  if (input.forwarder) env.LA_FORWARDER = input.forwarder;
  if (input.hostsPath) env.LA_HOSTS_PATH = input.hostsPath;
  if (input.logDir) env.LA_LOG_DIR = input.logDir;
  if (input.owner) env.LA_OWNER = input.owner;
  if (input.managedIps && input.managedIps.length > 0) env.LA_MANAGED_IPS = input.managedIps.join(" ");
  return env;
}

/** `/bin/bash` explicitly: the exec bit does not always survive bundling. */
export function applyArgv(
  applyScript: string,
  desiredStatePath: string,
  options: { restartForwarder?: boolean; noForwarder?: boolean } = {},
): string[] {
  const argv = ["/bin/bash", applyScript];
  if (options.restartForwarder) argv.push("--restart-forwarder");
  if (options.noForwarder) argv.push("--no-forwarder");
  argv.push(desiredStatePath);
  return argv;
}

export function uninstallArgv(uninstallScript: string): string[] {
  return ["/bin/bash", uninstallScript];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
//
// The tray prefers `bun run prompt.ts [--uninstall]` over building the osascript
// incantation itself (PrivilegedApply.command). Without the entrypoint below that
// invocation loaded this file as a library, defined some functions, exited 0 — so the
// menu item reported success and nothing was ever applied.
//
// This is also the only caller that can fill in LA_OWNER and LA_MANAGED_IPS: it can read
// the config, so it knows which loopback addresses this install actually allocated.
// apply.sh without LA_MANAGED_IPS considers the whole 127.0.0.2-254 pool fair game.

export type PrivilegedAction = "apply" | "uninstall";

export interface CliOptions {
  action: PrivilegedAction;
  restartForwarder: boolean;
  noForwarder: boolean;
  /** Print the argv and env instead of raising a prompt. Nothing runs as root. */
  dryRun: boolean;
  /**
   * Do not prompt if the root agent is already running: it watches desired-state.json and
   * has already done, or is about to do, whatever this apply would have done. This is what
   * makes the launch prompt a ONCE-per-session thing rather than a once-per-change one.
   * Ignored for `uninstall`, which must run as root whatever else is up.
   */
  ifNeeded: boolean;
}

/** Accepts both spellings the tray may send: `--uninstall` and a bare `uninstall`. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    action: "apply",
    restartForwarder: false,
    noForwarder: false,
    dryRun: false,
    ifNeeded: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case "uninstall": case "--uninstall": options.action = "uninstall"; break;
      case "apply": case "--apply": options.action = "apply"; break;
      case "--restart-forwarder": options.restartForwarder = true; break;
      case "--no-forwarder": options.noForwarder = true; break;
      case "--dry-run": case "--print-only": options.dryRun = true; break;
      case "--if-needed": options.ifNeeded = true; break;
      default: throw new Error(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return options;
}

/**
 * Is the root agent alive right now?
 *
 * The agent publishes its pid in forwarder-status.json; the file alone proves nothing,
 * because a crash leaves it behind. Signal 0 delivers nothing and only asks whether the pid
 * exists — and EPERM is a YES here, because the process existing and belonging to root is
 * exactly what the agent is.
 *
 * A false answer costs one prompt. A false TRUE would mean the user's change never lands,
 * so the check errs toward prompting.
 */
export async function agentIsRunning(statusPath?: string): Promise<boolean> {
  try {
    const { forwarderStatusPath } = await import("@localhost-aliases/core/paths");
    const path = statusPath ?? forwarderStatusPath();
    const raw = JSON.parse(await Bun.file(path).text()) as { pid?: unknown };
    const pid = raw?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
    if (pid === process.pid) return false; // our own pid is not evidence of an agent
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false; // no file, unreadable, or not JSON: assume not running and prompt
  }
}

/**
 * Every loopback address this install has ever handed out, so apply.sh and uninstall.sh
 * leave a pool address the user created for something else alone.
 */
export async function managedIpsFromConfig(): Promise<string[]> {
  try {
    const { loadConfig } = await import("@localhost-aliases/core");
    const config = await loadConfig();
    const ips = config.aliases.map((a) => a.ip).filter((ip): ip is string => typeof ip === "string" && ip.length > 0);
    return [...new Set(ips)].sort();
  } catch {
    return []; // no config yet: apply.sh falls back to "the whole pool is ours"
  }
}

export async function buildCliRequest(options: CliOptions): Promise<PrivilegedRequest> {
  const { configDir, desiredStatePath, logDir, runtimeLayout } = await import("@localhost-aliases/core/paths");
  const layout = runtimeLayout();
  const privilegedDir = layout.applyScript.slice(0, layout.applyScript.lastIndexOf("/"));

  const env = privilegedEnv({
    configDir: configDir(),
    forwarder: options.noForwarder ? undefined : layout.forwarder,
    logDir: logDir(),
    owner: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    managedIps: await managedIpsFromConfig(),
  });

  const argv =
    options.action === "uninstall"
      ? uninstallArgv(`${privilegedDir}/uninstall.sh`)
      : applyArgv(layout.applyScript, desiredStatePath(), options);

  const prompt =
    options.action === "uninstall"
      ? "Localhost Aliases needs to remove its /etc/hosts entries and loopback addresses."
      : "Localhost Aliases needs to update /etc/hosts and your loopback addresses.";

  return { argv, env, prompt };
}

export async function cliMain(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\nusage: prompt.ts [apply|uninstall] [--restart-forwarder] [--no-forwarder] [--if-needed] [--dry-run]\n`);
    return 2;
  }

  // The root-agent model, on the command line (docs/AGENT.md §1). With the agent up there is
  // nothing for a prompt to do: it is already watching desired-state.json and will reconcile
  // whatever the caller just wrote. Checked BEFORE the request is built, so no dialog is even
  // prepared. `--dry-run` still prints, because printing is what it is for; an uninstall
  // ignores this entirely, since it must stop the agent rather than ask it for a favour.
  if (options.ifNeeded && options.action === "apply" && !options.dryRun && (await agentIsRunning())) {
    process.stdout.write("LA_RESULT status=ok reason=agent-running prompt=skipped\n");
    return 0;
  }

  const request = await buildCliRequest(options);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ argv: request.argv, env: request.env }, null, 2)}\n`);
    return 0;
  }

  const result = await runPrivileged(request);
  if (result.summary) process.stdout.write(`LA_RESULT ${Object.entries(result.summary).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
  if (result.cancelled) {
    process.stderr.write("LA_ERROR step=prompt message=The administrator prompt was cancelled.\n");
    return 2;
  }
  if (!result.ok) {
    const e = result.error;
    process.stderr.write(`LA_ERROR step=${e?.step ?? "unknown"} message=${e?.message ?? "The privileged step failed."}\n`);
    return 1;
  }
  return 0;
}

/**
 * Only when this file really is the process. `bun test` reports `import.meta.main` for
 * every entry file it loads, and this one raises a password dialog — the same trap that
 * had the forwarder auto-start into the user's real config directory during a test run.
 */
const cliAutorun = process.env.LA_PRIVILEGED_CLI === "1" || process.env.NODE_ENV !== "test";
if (import.meta.main && cliAutorun) process.exit(await cliMain(process.argv.slice(2)));
