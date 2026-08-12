/**
 * The temp world each spec starts from, and the assertions that read it back.
 *
 * The hosts file starts as a copy of what a real `/etc/hosts` looks like, so a
 * test can prove the managed block was spliced into existing content instead of
 * replacing it — the single most dangerous thing this system does.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "@localhost-aliases/core";
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  CONFIG_DIR,
  CONFIG_PATH,
  HOSTS_PATH,
  STATE_DIR,
} from "./paths";
import { applyEmpty, clearJournal, helperStatus } from "./helper-control";

/** Mirrors `HOSTS_BEGIN` / `HOSTS_END` in packages/core/src/types.ts (frozen). */
export const HOSTS_BEGIN = "# >>> localhost-aliases >>>";
export const HOSTS_END = "# <<< localhost-aliases <<<";

/** Lines that must survive every apply, byte for byte. */
export const BASELINE_HOSTS = [
  "##",
  "# Host Database",
  "#",
  "# localhost is used to configure the loopback interface",
  "##",
  "127.0.0.1\tlocalhost",
  "255.255.255.255\tbroadcasthost",
  "::1             localhost",
  "",
].join("\n");

/** Recreates the temp state directory from scratch. Used once, by globalSetup. */
export function createStateDir(): void {
  rmSync(STATE_DIR, { recursive: true, force: true });
  for (const dir of [STATE_DIR, CONFIG_DIR, dirname(CLAUDE_CONFIG)]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(HOSTS_PATH, BASELINE_HOSTS);
}

/**
 * Back to first-run: no config, no MCP client configs, a pristine hosts file and
 * an empty journal. When the helper is up it is told to drop its routes first,
 * so its in-memory table cannot outlive the config that produced it.
 */
export async function resetState(): Promise<void> {
  if ((await helperStatus()) !== null) await applyEmpty();

  rmSync(CONFIG_PATH, { force: true });
  rmSync(`${CONFIG_PATH}.bak`, { force: true });
  rmSync(dirname(CLAUDE_CONFIG), { recursive: true, force: true });
  mkdirSync(dirname(CLAUDE_CONFIG), { recursive: true });
  writeFileSync(HOSTS_PATH, BASELINE_HOSTS);
  clearJournal();
}

// ---------------------------------------------------------------------------
// Reading the temp world back
// ---------------------------------------------------------------------------

export function readHostsFile(): string {
  return existsSync(HOSTS_PATH) ? readFileSync(HOSTS_PATH, "utf8") : "";
}

/** Hostnames declared inside the managed block, sorted and deduped. */
export function managedHostnames(): string[] {
  const content = readHostsFile();
  const begin = content.indexOf(HOSTS_BEGIN);
  const end = content.indexOf(HOSTS_END);
  if (begin === -1 || end === -1) return [];

  const hosts = new Set<string>();
  for (const line of content.slice(begin, end).split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    for (const host of text.split(/\s+/).slice(1)) hosts.add(host);
  }
  return [...hosts].sort();
}

export function readConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
}

export function readClientConfig(client: "claude" | "codex"): string | null {
  const path = client === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG;
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
