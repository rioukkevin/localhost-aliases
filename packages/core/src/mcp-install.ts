/**
 * Installing the stdio MCP server into Claude Code and Codex.
 *
 * The entrypoint is resolved through runtimeLayout(), never import.meta.dir: this module
 * is also imported by the Next dashboard, where webpack rewrites import.meta.dir to
 * undefined and would silently produce a broken command.
 */
import { claudeConfigPath, codexConfigPath, runtimeLayout } from "./paths.ts";
import { backupFile, readFileOrNull, writeFileAtomic } from "./atomic.ts";

export const MCP_SERVER_NAME = "localhost-aliases";

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type McpClientId = "claude" | "codex";

export interface McpClient {
  id: McpClientId;
  name: string;
  configPath: string;
  /** The client's config file exists. */
  installed: boolean;
  /** Our server is already registered in it. */
  configured: boolean;
}

/**
 * In a bundle mcpEntry is a compiled binary and runs directly; in a checkout it is a
 * .ts file and needs Bun in front of it.
 */
export function mcpServerSpec(dashboardPort?: number): McpServerSpec {
  const layout = runtimeLayout();
  const base: McpServerSpec =
    layout.mode === "bundle"
      ? { command: layout.mcpEntry, args: [] }
      : { command: layout.bun, args: ["run", layout.mcpEntry] };
  return dashboardPort === undefined
    ? base
    : { ...base, env: { LA_DASHBOARD_PORT: String(dashboardPort) } };
}

// --- Claude Code (~/.claude.json) -------------------------------------------

/**
 * Pure: takes the current file contents (null when absent) and returns the new ones.
 * Every other key is preserved. Malformed JSON throws rather than being overwritten —
 * this file holds the user's entire Claude Code configuration.
 */
export function upsertClaudeJson(existing: string | null, spec: McpServerSpec): string {
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error("~/.claude.json is not valid JSON; fix it before installing the MCP server.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("~/.claude.json does not contain a JSON object.");
    }
    root = parsed as Record<string, unknown>;
  }

  const current = root.mcpServers;
  const servers: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  servers[MCP_SERVER_NAME] = spec;

  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}

// --- Codex (~/.codex/config.toml) -------------------------------------------

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The TOML block for our server, ready to hand to upsertCodexToml. */
export function codexSnippet(spec: McpServerSpec): string {
  const lines = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
  ];
  if (spec.env && Object.keys(spec.env).length > 0) {
    const pairs = Object.entries(spec.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
    lines.push(`env = { ${pairs.join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

const CODEX_HEADER = `[mcp_servers.${MCP_SERVER_NAME}]`;

/**
 * Pure: replace our table in the TOML, or append it. Deliberately string-based —
 * a real TOML round-trip would reformat and reorder the user's whole file.
 */
export function upsertCodexToml(existing: string | null, snippet: string): string {
  const body = existing ?? "";
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === CODEX_HEADER);

  if (start === -1) {
    if (body.trim() === "") return snippet;
    const separator = body.endsWith("\n") ? "\n" : "\n\n";
    return body + separator + snippet;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  const head = before === "" ? "" : `${before}\n`;
  return head + snippet + (after.trim() === "" ? "" : `\n${after}`);
}

// --- install ----------------------------------------------------------------

export function clientConfigPath(client: McpClientId): string {
  return client === "claude" ? claudeConfigPath() : codexConfigPath();
}

export function isConfigured(client: McpClientId, contents: string | null): boolean {
  if (contents === null) return false;
  if (client === "codex") return contents.includes(CODEX_HEADER);
  try {
    const parsed = JSON.parse(contents) as { mcpServers?: Record<string, unknown> };
    return Boolean(parsed?.mcpServers && MCP_SERVER_NAME in parsed.mcpServers);
  } catch {
    return false;
  }
}

export async function detectClients(): Promise<McpClient[]> {
  const definitions: Array<{ id: McpClientId; name: string }> = [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
  ];
  return Promise.all(
    definitions.map(async ({ id, name }) => {
      const path = clientConfigPath(id);
      const contents = await readFileOrNull(path);
      return {
        id,
        name,
        configPath: path,
        installed: contents !== null,
        configured: isConfigured(id, contents),
      };
    }),
  );
}

export interface InstallResult {
  client: McpClientId;
  configPath: string;
  /** Path of the backup taken first, or null when there was no file to back up. */
  backupPath: string | null;
}

/** Back up, then atomically rewrite the client's config with our server registered. */
export async function installMcp(client: McpClientId, dashboardPort?: number): Promise<InstallResult> {
  const path = clientConfigPath(client);
  const existing = await readFileOrNull(path);
  const spec = mcpServerSpec(dashboardPort);
  const next =
    client === "claude" ? upsertClaudeJson(existing, spec) : upsertCodexToml(existing, codexSnippet(spec));

  const backupPath = await backupFile(path);
  await writeFileAtomic(path, next);
  return { client, configPath: path, backupPath };
}
