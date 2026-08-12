/**
 * One-click MCP registration for Claude Code (JSON) and Codex (TOML).
 *
 * The two `upsert*` functions are pure string -> string transforms so they can be
 * unit-tested hard: these files belong to the user and may contain anything.
 * Everything we do not own is preserved verbatim, comments included.
 */
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_ROOT, claudeConfigPath, codexConfigPath } from "./paths.ts";
import type { McpClientId, McpClientState } from "./types.ts";

/** Key under `mcpServers` in ~/.claude.json. */
export const MCP_SERVER_KEY = "localhost-aliases";
/** TOML table in ~/.codex/config.toml. TOML bare keys cannot contain "-". */
export const MCP_CODEX_TABLE = "mcp_servers.localhost_aliases";

/** packages/core/src -> packages/mcp/src/index.ts */
const ENTRY_FROM_CORE_SRC = ["..", "..", "mcp", "src", "index.ts"] as const;
/** <workspace root> -> packages/mcp/src/index.ts */
const ENTRY_FROM_ROOT = ["packages", "mcp", "src", "index.ts"] as const;

/**
 * Directory of this module, or null when the runtime does not expose one.
 *
 * `import.meta.dir` (Bun) and `import.meta.dirname` are replaced with `undefined`
 * by webpack, so any Next build of this package used to resolve against
 * `undefined` and throw. `import.meta.url` survives bundling but then points at
 * the bundle, not at the source tree — hence every candidate below is checked
 * against the filesystem instead of being trusted.
 */
function moduleDir(): string | null {
  // Each property is read as a direct `import.meta.x` member access: webpack
  // rewrites those to `undefined`, but rewrites a bare `import.meta` to `{}`.
  const fromDirname = (import.meta as { dirname?: string }).dirname;
  if (typeof fromDirname === "string" && fromDirname !== "") return fromDirname;

  const fromDir = (import.meta as { dir?: string }).dir;
  if (typeof fromDir === "string" && fromDir !== "") return fromDir;

  const url = (import.meta as { url?: string }).url;
  if (typeof url === "string" && url.startsWith("file:")) {
    try {
      return dirname(fileURLToPath(url));
    } catch {
      return null;
    }
  }
  return null;
}

/** Every plausible location of the entrypoint, best guess first. */
function entrypointCandidates(from: string | null): string[] {
  const candidates: string[] = [];
  if (from !== null) candidates.push(resolve(from, ...ENTRY_FROM_CORE_SRC));

  // A bundled core has no useful module dir, so the workspace root is found by
  // walking up from wherever the process actually runs (packages/web, e.g.).
  for (const start of [from, process.cwd()]) {
    if (start === null) continue;
    let current = resolve(start);
    for (;;) {
      candidates.push(resolve(current, ...ENTRY_FROM_ROOT));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  candidates.push(resolve(INSTALL_ROOT, ...ENTRY_FROM_ROOT));
  return candidates;
}

/**
 * Absolute path to the MCP entrypoint. `LA_MCP_ENTRYPOINT` wins outright — it is
 * the escape hatch for layouts we cannot guess (a relocated install, a bundle).
 * Otherwise the first candidate that exists on disk wins; a path is never
 * invented, because the spec ends up in the user's agent config.
 */
function mcpEntrypoint(): string {
  const explicit = process.env.LA_MCP_ENTRYPOINT;
  if (explicit !== undefined && explicit !== "") return resolve(explicit);

  const from = moduleDir();
  const candidates = entrypointCandidates(from);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) return found;

  throw new Error(
    `Could not locate the MCP server entrypoint (packages/mcp/src/index.ts). ` +
      `Searched from ${from ?? "an unknown module directory"} and ${process.cwd()}. ` +
      `Set LA_MCP_ENTRYPOINT to its absolute path.`,
  );
}

export function mcpServerSpec(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: "bun",
    args: [mcpEntrypoint()],
    env: { LA_DASHBOARD_PORT: String(process.env.LA_DASHBOARD_PORT ?? 7788) },
  };
}

// ---------------------------------------------------------------------------
// Snippets (also the copy-paste fallback shown in the UI)
// ---------------------------------------------------------------------------

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function claudeSnippet(): string {
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: mcpServerSpec() } }, null, 2)}\n`;
}

export function codexSnippet(): string {
  const spec = mcpServerSpec();
  const env = Object.entries(spec.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ");
  return [
    `[${MCP_CODEX_TABLE}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
    // Inline table: keeps our whole entry in one flat table, which makes the
    // section surgery below unambiguous.
    `env = { ${env} }`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pure config transforms
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Anything unparseable is treated as an empty config rather than an error: we back it up first. */
function parseJsonObject(existing: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(existing);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function upsertClaudeJson(existing: string): string {
  const root = parseJsonObject(existing);
  const servers = isRecord(root.mcpServers) ? root.mcpServers : {};
  root.mcpServers = { ...servers, [MCP_SERVER_KEY]: mcpServerSpec() };
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** `[ a . "b" ]` -> "a.b"; null when the line is not a plain table header. */
function tableKey(line: string): string | null {
  const match = /^\s*\[([^[\]]+)\]\s*$/.exec(line);
  const raw = match?.[1];
  if (raw === undefined) return null;
  return raw
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Replaces the snippet's table in place (including its sub-tables) or appends it
 * after a blank line. Every other line — comments, spacing, other tables — is untouched.
 */
export function upsertCodexToml(existing: string, snippet: string): string {
  const snippetLines = snippet.replace(/\s+$/, "").split("\n");
  const key = snippetLines.map(tableKey).find((k) => k !== null) ?? MCP_CODEX_TABLE;

  const lines = existing.split("\n");
  const start = lines.findIndex((line) => tableKey(line) === key);

  if (start === -1) {
    // Trailing whitespace is normalised so appending twice cannot drift.
    const base = existing.replace(/\s+$/, "");
    const block = `${snippetLines.join("\n")}\n`;
    return base === "" ? block : `${base}\n\n${block}`;
  }

  // The table ends at the next header that is neither itself nor one of its sub-tables.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!isTableHeader(line)) continue;
    const other = tableKey(line);
    if (other !== null && (other === key || other.startsWith(`${key}.`))) continue;
    end = i;
    break;
  }

  // Keep the blank lines that separated this table from the next one.
  let bodyEnd = end;
  while (bodyEnd > start + 1 && (lines[bodyEnd - 1] ?? "").trim() === "") bodyEnd--;
  const spacing = lines.slice(bodyEnd, end);

  return [...lines.slice(0, start), ...snippetLines, ...spacing, ...lines.slice(end)].join("\n");
}

// ---------------------------------------------------------------------------
// Detection + install
// ---------------------------------------------------------------------------

function configPathFor(client: McpClientId): string {
  return client === "claude" ? claudeConfigPath() : codexConfigPath();
}

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

export async function detectClients(): Promise<{ claude: McpClientState; codex: McpClientState }> {
  const claudePath = claudeConfigPath();
  const codexPath = codexConfigPath();
  const [claudeText, codexText] = await Promise.all([
    readIfExists(claudePath),
    readIfExists(codexPath),
  ]);

  const claudeServers = claudeText === null ? {} : parseJsonObject(claudeText).mcpServers;
  const claude: McpClientState = {
    configPath: claudePath,
    clientDetected: claudeText !== null,
    installed: isRecord(claudeServers) && MCP_SERVER_KEY in claudeServers,
  };

  const codex: McpClientState = {
    configPath: codexPath,
    clientDetected: codexText !== null,
    installed:
      codexText !== null && codexText.split("\n").some((line) => tableKey(line) === MCP_CODEX_TABLE),
  };

  return { claude, codex };
}

/** `<path>.bak-1`, `.bak-2`, … — never clobbers an earlier backup. */
async function backup(path: string, content: string): Promise<string> {
  let n = 1;
  while (existsSync(`${path}.bak-${n}`)) n++;
  const backupPath = `${path}.bak-${n}`;
  await Bun.write(backupPath, content);
  return backupPath;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Same-directory rename: the client never sees a half-written config.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}

export async function installMcp(
  client: McpClientId,
): Promise<{ ok: true; configPath: string; backupPath: string | null; snippet: string }> {
  const configPath = configPathFor(client);
  const existing = await readIfExists(configPath);
  const snippet = client === "claude" ? claudeSnippet() : codexSnippet();
  const next =
    client === "claude" ? upsertClaudeJson(existing ?? "") : upsertCodexToml(existing ?? "", snippet);

  const backupPath = existing === null ? null : await backup(configPath, existing);
  await writeAtomic(configPath, next);

  return { ok: true, configPath, backupPath, snippet };
}
