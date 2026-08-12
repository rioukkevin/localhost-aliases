/**
 * Every location this suite is allowed to touch, in one place.
 *
 * None of them is a real system path: the config directory, the hosts file, the
 * MCP client configs and the helper control socket all live under /tmp. That is
 * what lets the whole suite run with zero privileges and leave `/etc/hosts`,
 * `~/.config/localhost-aliases`, `~/.claude.json` and `~/.codex/config.toml`
 * exactly as it found them.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = resolve(FIXTURES_DIR, "..");
export const REPO_ROOT = resolve(E2E_DIR, "..");

/**
 * A unix socket path must fit in `sockaddr_un.sun_path` — 104 bytes on macOS —
 * so it sits directly in /tmp. Under the repo (or a scratch directory) the path
 * blows past the limit and `bind()` fails with ENAMETOOLONG.
 */
export const SOCKET_PATH = "/tmp/la-e2e.sock";

/** Everything else the suite writes. Wiped and recreated by globalSetup. */
export const STATE_DIR = "/tmp/la-e2e";
export const CONFIG_DIR = join(STATE_DIR, "config");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const HOSTS_PATH = join(STATE_DIR, "hosts");
export const JOURNAL_PATH = join(STATE_DIR, "applies.json");
export const PID_PATH = join(STATE_DIR, "helper.pid");
export const HELPER_LOG = join(STATE_DIR, "helper.log");
export const LOG_DIR = join(STATE_DIR, "logs");
export const CLAUDE_CONFIG = join(STATE_DIR, "mcp", "claude.json");
export const CODEX_CONFIG = join(STATE_DIR, "mcp", "codex.toml");

export const FAKE_HELPER = join(FIXTURES_DIR, "fake-helper.ts");

/**
 * The suite's own Next build tree, relative to packages/web.
 *
 * Sharing `.next` with a dev server (or with another dashboard) corrupts both —
 * see packages/web/lib/dist-lock.ts. Its own tree means the suite can never
 * destroy the production build, and never has to wait for whoever holds it.
 */
export const NEXT_DIST_DIR = ".next-e2e";

/** Not 7788: a real dashboard may already own the production port. */
export const DASHBOARD_PORT = 7799;
export const BASE_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

/**
 * The environment contract from docs/ARCHITECTURE.md, pointed at the temp state.
 * Shared by the dashboard under test and the fake helper so both ends agree on
 * the socket and on the hosts file.
 */
export function e2eEnv(): Record<string, string> {
  return {
    LA_SOCKET_PATH: SOCKET_PATH,
    LA_CONFIG_DIR: CONFIG_DIR,
    LA_HOSTS_PATH: HOSTS_PATH,
    LA_LOG_DIR: LOG_DIR,
    LA_CLAUDE_CONFIG: CLAUDE_CONFIG,
    LA_CODEX_CONFIG: CODEX_CONFIG,
    LA_DASHBOARD_PORT: String(DASHBOARD_PORT),
    LA_HELPER_JOURNAL: JOURNAL_PATH,
    LA_NEXT_DIST_DIR: NEXT_DIST_DIR,
  };
}

/** `e2eEnv()` on top of the inherited environment, for spawning child processes. */
export function withE2eEnv(): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...e2eEnv() };
}
