/**
 * Every filesystem location the system touches, in one place.
 * Paths are resolved lazily so tests can override HOME / LA_CONFIG_DIR.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** launchd labels. Changing these breaks upgrade/uninstall of existing installs. */
export const HELPER_LABEL = "dev.localhost-aliases.helper";
export const AGENT_LABEL = "dev.localhost-aliases.web";

/** Where `scripts/install.sh` copies the runtime bundle. Root-owned, read-only to users. */
export const INSTALL_ROOT = "/usr/local/lib/localhost-aliases";

/** Control socket for the privileged helper. Created by root, chowned to the install user, mode 0600. */
export const SOCKET_PATH = "/var/run/localhost-aliases.sock";

export const HOSTS_PATH = process.env.LA_HOSTS_PATH ?? "/etc/hosts";

export const HELPER_PLIST_PATH = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`;

/** User config directory. `LA_CONFIG_DIR` overrides it (used by every test suite). */
export function configDir(): string {
  return process.env.LA_CONFIG_DIR ?? join(homedir(), ".config", "localhost-aliases");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Local certificate authority material. Key is written 0600. */
export function caDir(): string {
  return join(configDir(), "ca");
}
export function caCertPath(): string {
  return join(caDir(), "rootCA.pem");
}
export function caKeyPath(): string {
  return join(caDir(), "rootCA-key.pem");
}
/** Leaf certificate covering every enabled alias hostname via SAN entries. */
export function leafCertPath(): string {
  return join(caDir(), "aliases.pem");
}
export function leafKeyPath(): string {
  return join(caDir(), "aliases-key.pem");
}

export function logDir(): string {
  return process.env.LA_LOG_DIR ?? join(homedir(), "Library", "Logs", "localhost-aliases");
}

export function agentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

/** Claude Code stores MCP servers in ~/.claude.json under `mcpServers`. */
export function claudeConfigPath(): string {
  return process.env.LA_CLAUDE_CONFIG ?? join(homedir(), ".claude.json");
}

/** Codex stores MCP servers in ~/.codex/config.toml under `[mcp_servers.*]`. */
export function codexConfigPath(): string {
  return process.env.LA_CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");
}

/** Base URL of the user-space web API. Read by the MCP server and the tray. */
export function dashboardUrl(port = Number(process.env.LA_DASHBOARD_PORT ?? 7788)): string {
  return `http://127.0.0.1:${port}`;
}
