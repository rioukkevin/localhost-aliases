/**
 * Every filesystem location v2 touches. Resolved lazily so tests can redirect via LA_*.
 * There is no /Library, no /var/run and no LaunchDaemon in v2 — nothing is installed
 * system-wide except the /etc/hosts managed block and the lo0 aliases, both reversible.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "Localhost Aliases";
export const BUNDLE_ID = "dev.localhost-aliases.app";

export const HOSTS_PATH = process.env.LA_HOSTS_PATH ?? "/etc/hosts";

/** User state directory. LA_CONFIG_DIR overrides it — every test must set it. */
export function configDir(): string {
  return process.env.LA_CONFIG_DIR ?? join(homedir(), ".config", "localhost-aliases");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Desired state handed to the privileged script. User-writable by design. */
export function desiredStatePath(): string {
  return join(configDir(), "desired-state.json");
}
/** Routes the root forwarder watches. A port-only change is picked up without a prompt. */
export function routesPath(): string {
  return join(configDir(), "routes.json");
}
/** Status the root forwarder writes so the UI can show real state without privileges. */
export function forwarderStatusPath(): string {
  return join(configDir(), "forwarder-status.json");
}
/**
 * Heartbeat the app touches. The forwarder runs as root and a user process cannot kill it,
 * so it watches this file and exits on its own once the app stops touching it.
 */
export function livenessPath(): string {
  return join(configDir(), "liveness");
}
/** How stale the heartbeat may get before the forwarder exits. */
export const LIVENESS_TIMEOUT_MS = 15_000;
export const LIVENESS_TOUCH_MS = 5_000;

/**
 * The dashboard/tray request channel.
 *
 * A web page cannot raise a macOS admin prompt, and by design the dashboard never runs a
 * privileged command. So a button click writes a REQUEST here; the tray polls it, runs the
 * privileged work behind the one admin prompt, and writes the RESULT back. Two plain files
 * in the user's own config dir — no port, no URL scheme, nothing to authenticate.
 */
export function applyRequestPath(): string {
  return join(configDir(), "apply-request.json");
}
export function applyResultPath(): string {
  return join(configDir(), "apply-result.json");
}
/** How often the tray checks for a new request. Just a stat, so it can be brisk. */
export const APPLY_POLL_MS = 1_000;
/**
 * A request older than this is ignored rather than replayed — otherwise launching the app
 * would re-run whatever was last asked for, raising a password prompt nobody asked for.
 */
export const APPLY_REQUEST_TTL_MS = 90_000;

export function caDir(): string {
  return join(configDir(), "ca");
}
export function caCertPath(): string {
  return join(caDir(), "rootCA.pem");
}
export function caKeyPath(): string {
  return join(caDir(), "rootCA-key.pem");
}
export function dashboardCertPath(): string {
  return join(caDir(), "dashboard.pem");
}
export function dashboardKeyPath(): string {
  return join(caDir(), "dashboard-key.pem");
}

/**
 * One certificate covers every alias, with each hostname as a SAN. One file pair instead of
 * N keeps the forwarder trivial — every TLS listener loads the same two files — and it is
 * re-issued whenever the hostname set changes. The tradeoff, stated plainly: this cert names
 * all of your aliases, so presenting it to one of them reveals the others' names. On a
 * single-user dev machine that is a non-issue; it would not be on a shared host.
 */
export function aliasCertPath(): string {
  return join(caDir(), "aliases.pem");
}
export function aliasKeyPath(): string {
  return join(caDir(), "aliases-key.pem");
}

export function logDir(): string {
  return process.env.LA_LOG_DIR ?? join(homedir(), "Library", "Logs", "localhost-aliases");
}

export function claudeConfigPath(): string {
  return process.env.LA_CLAUDE_CONFIG ?? join(homedir(), ".claude.json");
}
export function codexConfigPath(): string {
  return process.env.LA_CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");
}

/**
 * Runtime layout. In a built .app everything lives under Contents/Resources; in a git
 * checkout it lives in the workspace. Nothing may assume a checkout.
 */
export interface RuntimeLayout {
  mode: "bundle" | "dev";
  /** Root the other paths hang off: Contents/Resources, or the repo root. */
  root: string;
  bun: string;
  dashboardDir: string;
  forwarder: string;
  applyScript: string;
  mcpEntry: string;
}

const BUNDLE_MARKER = ".app/Contents/";
const RESOURCES_SUFFIX = "/Contents/Resources";

function bundleLayout(resources: string): RuntimeLayout {
  return {
    mode: "bundle",
    root: resources,
    bun: join(resources, "bin", "bun"),
    dashboardDir: join(resources, "dashboard"),
    forwarder: join(resources, "forwarder"),
    applyScript: join(resources, "privileged", "apply.sh"),
    mcpEntry: join(resources, "mcp"),
  };
}

function devLayout(root: string): RuntimeLayout {
  return {
    mode: "dev",
    root,
    bun: process.env.LA_BUN ?? "bun",
    dashboardDir: join(root, "packages", "dashboard"),
    forwarder: join(root, "packages", "forwarder", "src", "index.ts"),
    applyScript: join(root, "packages", "privileged", "apply.sh"),
    mcpEntry: join(root, "packages", "mcp", "src", "index.ts"),
  };
}

/**
 * Resolve where the runtime pieces live.
 *
 * The mode is decided by what the root LOOKS LIKE, never by whether an override was supplied.
 * The tray always passes LA_RUNTIME_ROOT (pointing at Contents/Resources), so treating an
 * override as "must be dev" silently gave the installed app the checkout layout: it advertised
 * <Resources>/packages/privileged/apply.sh, which does not exist, and the same for the forwarder.
 * LA_RUNTIME_MODE forces the answer when a test needs the dev layout under a bundle-shaped path.
 */
export function runtimeLayout(): RuntimeLayout {
  const forced = process.env.LA_RUNTIME_MODE;
  const override = process.env.LA_RUNTIME_ROOT;

  if (override) {
    const looksLikeBundle = override.endsWith(RESOURCES_SUFFIX);
    const bundle = forced ? forced === "bundle" : looksLikeBundle;
    return bundle ? bundleLayout(override) : devLayout(override);
  }

  const exec = process.execPath;
  const idx = exec.indexOf(BUNDLE_MARKER);
  if (idx !== -1 && forced !== "dev") {
    return bundleLayout(join(exec.slice(0, idx + BUNDLE_MARKER.length), "Resources"));
  }
  return devLayout(process.env.LA_REPO_ROOT ?? process.cwd());
}

export function dashboardUrl(port = Number(process.env.LA_DASHBOARD_PORT ?? 7788)): string {
  return `http://127.0.0.1:${port}`;
}
