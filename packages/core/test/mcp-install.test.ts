import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  MCP_CODEX_TABLE,
  MCP_SERVER_KEY,
  claudeSnippet,
  codexSnippet,
  detectClients,
  installMcp,
  mcpServerSpec,
  upsertClaudeJson,
  upsertCodexToml,
} from "../src/mcp-install.ts";

const dirs: string[] = [];
let env: Record<string, string | undefined>;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "la-mcp-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  env = {
    LA_CLAUDE_CONFIG: process.env.LA_CLAUDE_CONFIG,
    LA_CODEX_CONFIG: process.env.LA_CODEX_CONFIG,
    LA_DASHBOARD_PORT: process.env.LA_DASHBOARD_PORT,
  };
  const dir = tempDir();
  // Never point at the real ~/.claude.json or ~/.codex/config.toml.
  process.env.LA_CLAUDE_CONFIG = join(dir, "claude", ".claude.json");
  process.env.LA_CODEX_CONFIG = join(dir, "codex", "config.toml");
});

afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mcpServerSpec", () => {
  test("runs the MCP entrypoint with bun from an absolute path", () => {
    const spec = mcpServerSpec();
    expect(spec.command).toBe("bun");
    expect(spec.args).toHaveLength(1);
    expect(isAbsolute(spec.args[0]!)).toBe(true);
    expect(spec.args[0]!.endsWith("/packages/mcp/src/index.ts")).toBe(true);
  });

  test("the entrypoint path does not depend on the cwd", () => {
    const before = process.cwd();
    process.chdir("/");
    try {
      expect(mcpServerSpec().args[0]).toBe(mcpServerSpec().args[0]);
      expect(isAbsolute(mcpServerSpec().args[0]!)).toBe(true);
    } finally {
      process.chdir(before);
    }
  });

  test("LA_MCP_ENTRYPOINT overrides the derived path", () => {
    const before = process.env.LA_MCP_ENTRYPOINT;
    process.env.LA_MCP_ENTRYPOINT = "/opt/elsewhere/mcp/index.ts";
    try {
      expect(mcpServerSpec().args).toEqual(["/opt/elsewhere/mcp/index.ts"]);
    } finally {
      if (before === undefined) delete process.env.LA_MCP_ENTRYPOINT;
      else process.env.LA_MCP_ENTRYPOINT = before;
    }
  });

  test("the resolved entrypoint exists on disk", () => {
    expect(existsSync(mcpServerSpec().args[0]!)).toBe(true);
  });

  test("carries the dashboard port, defaulting to 7788", () => {
    delete process.env.LA_DASHBOARD_PORT;
    expect(mcpServerSpec().env).toEqual({ LA_DASHBOARD_PORT: "7788" });
    process.env.LA_DASHBOARD_PORT = "9999";
    expect(mcpServerSpec().env).toEqual({ LA_DASHBOARD_PORT: "9999" });
  });
});

describe("snippets", () => {
  test("claudeSnippet is pasteable JSON nested under mcpServers", () => {
    const parsed = JSON.parse(claudeSnippet());
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
  });

  test("codexSnippet is a single flat TOML table", () => {
    const snippet = codexSnippet();
    expect(snippet.split("\n")[0]).toBe(`[${MCP_CODEX_TABLE}]`);
    expect(snippet).toContain('command = "bun"');
    expect(snippet).toContain(`args = ["${mcpServerSpec().args[0]}"]`);
    expect(snippet).toContain('env = { LA_DASHBOARD_PORT = "7788" }');
  });
});

describe("upsertClaudeJson", () => {
  test("starts from an empty object when the input is empty", () => {
    const parsed = JSON.parse(upsertClaudeJson(""));
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
  });

  test.each(["   \n ", "{ not json", "null", "[1,2,3]", '"a string"'])(
    "recovers from malformed input %p",
    (input) => {
      const parsed = JSON.parse(upsertClaudeJson(input));
      expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
    },
  );

  test("preserves every other key and other MCP servers", () => {
    const existing = JSON.stringify({
      numStartups: 42,
      projects: { "/tmp/x": { allowedTools: ["Bash"] } },
      mcpServers: { other: { command: "node", args: ["server.js"] } },
      theme: "dark",
    });
    const parsed = JSON.parse(upsertClaudeJson(existing));
    expect(parsed.numStartups).toBe(42);
    expect(parsed.projects["/tmp/x"].allowedTools).toEqual(["Bash"]);
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.other).toEqual({ command: "node", args: ["server.js"] });
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
  });

  test("replaces a stale entry instead of duplicating it", () => {
    const existing = JSON.stringify({
      mcpServers: { [MCP_SERVER_KEY]: { command: "node", args: ["/old/path.js"] } },
    });
    const parsed = JSON.parse(upsertClaudeJson(existing));
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
    expect(Object.keys(parsed.mcpServers)).toEqual([MCP_SERVER_KEY]);
  });

  test("replaces an mcpServers key that is not an object", () => {
    const parsed = JSON.parse(upsertClaudeJson('{ "mcpServers": "oops" }'));
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
  });

  test("is pretty-printed with 2 spaces and a trailing newline", () => {
    const out = upsertClaudeJson('{"a":1}');
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n")[1]).toBe('  "a": 1,');
  });

  test("is idempotent", () => {
    const once = upsertClaudeJson('{ "theme": "dark" }');
    expect(upsertClaudeJson(once)).toBe(once);
    expect(upsertClaudeJson(upsertClaudeJson(once))).toBe(once);
  });
});

describe("upsertCodexToml", () => {
  const snippet = codexSnippet();

  test("writes the table into an empty file", () => {
    expect(upsertCodexToml("", snippet)).toBe(`${snippet}\n`);
    expect(upsertCodexToml("\n\n  \n", snippet)).toBe(`${snippet}\n`);
  });

  test("appends after a blank line, preserving the original bytes", () => {
    const existing = 'model = "gpt-5"\n';
    expect(upsertCodexToml(existing, snippet)).toBe(`model = "gpt-5"\n\n${snippet}\n`);
  });

  test("appends when the file has no trailing newline", () => {
    expect(upsertCodexToml('model = "gpt-5"', snippet)).toBe(`model = "gpt-5"\n\n${snippet}\n`);
  });

  test("replaces an existing table in place", () => {
    const existing = [
      `[${MCP_CODEX_TABLE}]`,
      'command = "old"',
      'args = ["/old/path.ts"]',
      "",
    ].join("\n");
    expect(upsertCodexToml(existing, snippet)).toBe(`${snippet}\n`);
  });

  test("preserves adjacent tables, comments and top-level keys", () => {
    const existing = [
      "# my codex config",
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "node" # keep this comment',
      "",
      "# our block below",
      `[${MCP_CODEX_TABLE}]`,
      'command = "stale"',
      "",
      "[tools]",
      "web_search = true",
      "",
    ].join("\n");
    const out = upsertCodexToml(existing, snippet);
    expect(out).toBe(
      [
        "# my codex config",
        'model = "gpt-5"',
        "",
        "[mcp_servers.other]",
        'command = "node" # keep this comment',
        "",
        "# our block below",
        ...snippet.split("\n"),
        "",
        "[tools]",
        "web_search = true",
        "",
      ].join("\n"),
    );
  });

  test("replaces our sub-tables too", () => {
    const existing = [
      `[${MCP_CODEX_TABLE}]`,
      'command = "stale"',
      "",
      `[${MCP_CODEX_TABLE}.env]`,
      'LA_DASHBOARD_PORT = "1234"',
      "",
      "[other]",
      "x = 1",
      "",
    ].join("\n");
    const out = upsertCodexToml(existing, snippet);
    expect(out).toBe([...snippet.split("\n"), "", "[other]", "x = 1", ""].join("\n"));
    expect(out).not.toContain('LA_DASHBOARD_PORT = "1234"');
  });

  test("matches a quoted or loosely spaced header", () => {
    const existing = `[ mcp_servers . "localhost_aliases" ]\ncommand = "stale"\n`;
    expect(upsertCodexToml(existing, snippet)).toBe(`${snippet}\n`);
  });

  test("does not touch a table whose name merely starts the same", () => {
    const existing = `[mcp_servers.localhost_aliases_backup]\ncommand = "keep"\n`;
    const out = upsertCodexToml(existing, snippet);
    expect(out).toBe(`${existing.trimEnd()}\n\n${snippet}\n`);
    expect(out).toContain('command = "keep"');
  });

  test("is idempotent for both the append and the replace path", () => {
    const cases = [
      "",
      'model = "gpt-5"\n',
      `# lead\n[a]\nx = 1\n\n[${MCP_CODEX_TABLE}]\ncommand = "stale"\n\n[b]\ny = 2\n`,
    ];
    for (const input of cases) {
      const once = upsertCodexToml(input, snippet);
      expect(upsertCodexToml(once, snippet)).toBe(once);
      expect(upsertCodexToml(upsertCodexToml(once, snippet), snippet)).toBe(once);
    }
  });

  test("only ever contains one of our tables", () => {
    const twice = upsertCodexToml(upsertCodexToml("", snippet), snippet);
    expect(twice.split(`[${MCP_CODEX_TABLE}]`)).toHaveLength(2);
  });
});

describe("detectClients", () => {
  test("reports missing config files as undetected", async () => {
    const { claude, codex } = await detectClients();
    expect(claude).toEqual({
      configPath: process.env.LA_CLAUDE_CONFIG!,
      clientDetected: false,
      installed: false,
    });
    expect(codex).toEqual({
      configPath: process.env.LA_CODEX_CONFIG!,
      clientDetected: false,
      installed: false,
    });
  });

  test("detects a client whose config exists without our entry", async () => {
    await Bun.write(process.env.LA_CLAUDE_CONFIG!, '{ "mcpServers": { "other": {} } }');
    await Bun.write(process.env.LA_CODEX_CONFIG!, '[mcp_servers.other]\ncommand = "node"\n');
    const { claude, codex } = await detectClients();
    expect(claude).toMatchObject({ clientDetected: true, installed: false });
    expect(codex).toMatchObject({ clientDetected: true, installed: false });
  });

  test("reports installed after installMcp", async () => {
    await installMcp("claude");
    await installMcp("codex");
    const { claude, codex } = await detectClients();
    expect(claude).toMatchObject({ clientDetected: true, installed: true });
    expect(codex).toMatchObject({ clientDetected: true, installed: true });
  });

  test("a corrupt claude config is detected but not installed", async () => {
    await Bun.write(process.env.LA_CLAUDE_CONFIG!, "{ broken");
    const { claude } = await detectClients();
    expect(claude).toMatchObject({ clientDetected: true, installed: false });
  });
});

describe("installMcp", () => {
  test("creates the claude config and its parent dir, with no backup", async () => {
    const result = await installMcp("claude");
    expect(result).toEqual({
      ok: true,
      configPath: process.env.LA_CLAUDE_CONFIG!,
      backupPath: null,
      snippet: claudeSnippet(),
    });
    const parsed = JSON.parse(await Bun.file(result.configPath).text());
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual(mcpServerSpec());
  });

  test("creates the codex config and its parent dir", async () => {
    const result = await installMcp("codex");
    expect(result.backupPath).toBeNull();
    expect(result.snippet).toBe(codexSnippet());
    expect(await Bun.file(result.configPath).text()).toBe(`${codexSnippet()}\n`);
  });

  test("backs up the original and numbers backups without clobbering", async () => {
    const path = process.env.LA_CODEX_CONFIG!;
    await Bun.write(path, 'model = "gpt-5"\n');

    const first = await installMcp("codex");
    expect(first.backupPath).toBe(`${path}.bak-1`);
    expect(await Bun.file(`${path}.bak-1`).text()).toBe('model = "gpt-5"\n');

    const second = await installMcp("codex");
    expect(second.backupPath).toBe(`${path}.bak-2`);
    expect(await Bun.file(`${path}.bak-1`).text()).toBe('model = "gpt-5"\n');
    expect(await Bun.file(`${path}.bak-2`).text()).toBe(await Bun.file(path).text());

    const third = await installMcp("codex");
    expect(third.backupPath).toBe(`${path}.bak-3`);
  });

  test("installing twice leaves the file unchanged", async () => {
    await installMcp("claude");
    const once = await Bun.file(process.env.LA_CLAUDE_CONFIG!).text();
    await installMcp("claude");
    expect(await Bun.file(process.env.LA_CLAUDE_CONFIG!).text()).toBe(once);
  });

  test("leaves no temp file behind", async () => {
    const result = await installMcp("claude");
    const dir = result.configPath.slice(0, result.configPath.lastIndexOf("/"));
    const entries = [...new Bun.Glob("*").scanSync({ cwd: dir, dot: true })];
    expect(entries).toEqual([".claude.json"]);
    expect(existsSync(`${result.configPath}.bak-1`)).toBe(false);
  });
});
