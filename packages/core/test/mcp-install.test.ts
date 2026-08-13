import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexSnippet,
  detectClients,
  installMcp,
  isConfigured,
  MCP_SERVER_NAME,
  mcpServerSpec,
  upsertClaudeJson,
  upsertCodexToml,
  type McpServerSpec,
} from "../src/mcp-install.ts";

const SPEC: McpServerSpec = { command: "/bin/bun", args: ["run", "/tmp/mcp/index.ts"] };

// Every path below is redirected into a temp dir: nothing here may reach the real
// ~/.claude.json or ~/.codex/config.toml.
let dir: string;
const saved = {
  claude: process.env.LA_CLAUDE_CONFIG,
  codex: process.env.LA_CODEX_CONFIG,
  root: process.env.LA_RUNTIME_ROOT,
  bun: process.env.LA_BUN,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "la-mcp-"));
  process.env.LA_CLAUDE_CONFIG = join(dir, "claude.json");
  process.env.LA_CODEX_CONFIG = join(dir, "codex", "config.toml");
  process.env.LA_RUNTIME_ROOT = join(dir, "repo");
  process.env.LA_BUN = "/opt/bun";
});

afterEach(() => {
  for (const [key, value] of [
    ["LA_CLAUDE_CONFIG", saved.claude],
    ["LA_CODEX_CONFIG", saved.codex],
    ["LA_RUNTIME_ROOT", saved.root],
    ["LA_BUN", saved.bun],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("mcpServerSpec", () => {
  test("dev layout runs the entrypoint through Bun", () => {
    const spec = mcpServerSpec();
    expect(spec.command).toBe("/opt/bun");
    expect(spec.args).toEqual(["run", join(dir, "repo", "packages", "mcp", "src", "index.ts")]);
    expect(spec.env).toBeUndefined();
  });

  test("the entrypoint is absolute, never relative to the importing module", () => {
    expect(mcpServerSpec().args.at(-1)!.startsWith("/")).toBe(true);
  });

  test("a dashboard port becomes an env var", () => {
    expect(mcpServerSpec(9100).env).toEqual({ LA_DASHBOARD_PORT: "9100" });
  });
});

describe("upsertClaudeJson", () => {
  test("creates the file from nothing", () => {
    expect(JSON.parse(upsertClaudeJson(null, SPEC))).toEqual({ mcpServers: { [MCP_SERVER_NAME]: SPEC } });
  });

  test("treats an empty file as empty config", () => {
    expect(JSON.parse(upsertClaudeJson("   \n", SPEC)).mcpServers[MCP_SERVER_NAME]).toEqual(SPEC);
  });

  test("preserves every other key and every other server", () => {
    const existing = JSON.stringify({
      numStartups: 12,
      projects: { "/a": { allowedTools: [] } },
      mcpServers: { other: { command: "x", args: [] } },
    });
    const result = JSON.parse(upsertClaudeJson(existing, SPEC));
    expect(result.numStartups).toBe(12);
    expect(result.projects).toEqual({ "/a": { allowedTools: [] } });
    expect(result.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(result.mcpServers[MCP_SERVER_NAME]).toEqual(SPEC);
  });

  test("is idempotent and overwrites a stale entry", () => {
    const stale = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "old", args: [] } } });
    const once = upsertClaudeJson(stale, SPEC);
    expect(upsertClaudeJson(once, SPEC)).toBe(once);
    expect(JSON.parse(once).mcpServers[MCP_SERVER_NAME]).toEqual(SPEC);
  });

  test("replaces a non-object mcpServers rather than crashing", () => {
    expect(JSON.parse(upsertClaudeJson('{"mcpServers": []}', SPEC)).mcpServers[MCP_SERVER_NAME]).toEqual(SPEC);
  });

  test("refuses to overwrite malformed JSON", () => {
    expect(() => upsertClaudeJson("{oops", SPEC)).toThrow(/not valid JSON/);
    expect(() => upsertClaudeJson("[1,2]", SPEC)).toThrow(/JSON object/);
  });

  test("ends with a newline", () => {
    expect(upsertClaudeJson(null, SPEC).endsWith("\n")).toBe(true);
  });
});

describe("codex TOML", () => {
  test("snippet shape", () => {
    expect(codexSnippet(SPEC)).toBe(
      `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/bun"\nargs = ["run", "/tmp/mcp/index.ts"]\n`,
    );
  });

  test("snippet includes env when present", () => {
    expect(codexSnippet({ ...SPEC, env: { LA_DASHBOARD_PORT: "7788" } })).toContain(
      'env = { LA_DASHBOARD_PORT = "7788" }',
    );
  });

  test("creates the file from nothing", () => {
    expect(upsertCodexToml(null, codexSnippet(SPEC))).toBe(codexSnippet(SPEC));
    expect(upsertCodexToml("\n\n", codexSnippet(SPEC))).toBe(codexSnippet(SPEC));
  });

  test("appends below existing config", () => {
    const existing = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const result = upsertCodexToml(existing, codexSnippet(SPEC));
    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
  });

  test("separates when the file has no trailing newline", () => {
    expect(upsertCodexToml('model = "gpt-5"', codexSnippet(SPEC))).toBe(
      `model = "gpt-5"\n\n${codexSnippet(SPEC)}`,
    );
  });

  test("replaces our table in place, keeping tables around it", () => {
    const existing = `model = "gpt-5"\n\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "old"\nargs = []\n\n[other]\nkeep = true\n`;
    const result = upsertCodexToml(existing, codexSnippet(SPEC));
    expect(result).toContain('command = "/bin/bun"');
    expect(result).not.toContain('command = "old"');
    expect(result).toContain("[other]\nkeep = true");
    expect(result).toContain('model = "gpt-5"');
    expect(result.match(new RegExp(`\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`, "g"))).toHaveLength(1);
  });

  test("is idempotent", () => {
    const once = upsertCodexToml('model = "gpt-5"\n', codexSnippet(SPEC));
    expect(upsertCodexToml(once, codexSnippet(SPEC))).toBe(once);
  });

  test("replacing the last table leaves no trailing junk", () => {
    const existing = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "old"\n`;
    expect(upsertCodexToml(existing, codexSnippet(SPEC))).toBe(codexSnippet(SPEC));
  });
});

describe("isConfigured", () => {
  test("claude", () => {
    expect(isConfigured("claude", null)).toBe(false);
    expect(isConfigured("claude", "{}")).toBe(false);
    expect(isConfigured("claude", "{oops")).toBe(false);
    expect(isConfigured("claude", upsertClaudeJson(null, SPEC))).toBe(true);
  });

  test("codex", () => {
    expect(isConfigured("codex", null)).toBe(false);
    expect(isConfigured("codex", 'model = "x"')).toBe(false);
    expect(isConfigured("codex", codexSnippet(SPEC))).toBe(true);
  });
});

describe("detectClients", () => {
  test("reports both clients as absent on a clean machine", async () => {
    const clients = await detectClients();
    expect(clients.map((c) => c.id)).toEqual(["claude", "codex"]);
    expect(clients.every((c) => !c.installed && !c.configured)).toBe(true);
    expect(clients[0]!.configPath).toBe(join(dir, "claude.json"));
  });

  test("reports installed-but-unconfigured", async () => {
    await writeFile(join(dir, "claude.json"), "{}");
    const claude = (await detectClients())[0]!;
    expect(claude.installed).toBe(true);
    expect(claude.configured).toBe(false);
  });

  test("reports configured after install", async () => {
    await installMcp("claude");
    expect((await detectClients())[0]!.configured).toBe(true);
  });
});

describe("installMcp", () => {
  test("creates the claude config with no backup when there was no file", async () => {
    const result = await installMcp("claude");
    expect(result.backupPath).toBeNull();
    const written = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(written.mcpServers[MCP_SERVER_NAME].command).toBe("/opt/bun");
  });

  test("backs up an existing file before rewriting it", async () => {
    const path = join(dir, "claude.json");
    await writeFile(path, '{"numStartups": 3}');
    const result = await installMcp("claude");
    expect(result.backupPath).not.toBeNull();
    expect(await readFile(result.backupPath!, "utf8")).toBe('{"numStartups": 3}');
    expect(JSON.parse(await readFile(path, "utf8")).numStartups).toBe(3);
  });

  test("creates the codex config directory", async () => {
    const result = await installMcp("codex", 7788);
    expect(result.configPath).toBe(join(dir, "codex", "config.toml"));
    const text = await readFile(result.configPath, "utf8");
    expect(text).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(text).toContain('LA_DASHBOARD_PORT = "7788"');
  });

  test("is idempotent and leaves no temp files", async () => {
    await installMcp("claude");
    const first = await readFile(join(dir, "claude.json"), "utf8");
    await installMcp("claude");
    expect(await readFile(join(dir, "claude.json"), "utf8")).toBe(first);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a malformed claude config is left untouched", async () => {
    const path = join(dir, "claude.json");
    await writeFile(path, "{oops");
    await expect(installMcp("claude")).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, "utf8")).toBe("{oops");
  });
});
