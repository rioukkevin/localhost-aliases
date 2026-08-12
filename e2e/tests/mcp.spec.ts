import { existsSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../fixtures/paths";
import { startHelper } from "../fixtures/helper-control";
import { readClientConfig, resetState } from "../fixtures/state";

/** Content the installer has to preserve verbatim. */
const EXISTING_CODEX = ['# my own settings', '[history]', 'persistence = "save-all"', ""].join("\n");

test.beforeAll(async () => {
  await startHelper();
});

test.beforeEach(async () => {
  await resetState();
  // Codex "detected but not installed", Claude Code "not detected" — the two
  // states the cards have to tell apart. Both paths are under /tmp.
  writeFileSync(CODEX_CONFIG, EXISTING_CODEX);
});

test("the cards report detection state and always offer the copy-paste snippet", async ({
  page,
}) => {
  await page.goto("/mcp");

  await expect(page.getByTestId("mcp-card-claude")).toBeVisible();
  await expect(page.getByTestId("mcp-card-codex")).toBeVisible();
  await expect(page.getByTestId("mcp-state-claude")).toContainText("client not detected");
  await expect(page.getByTestId("mcp-state-codex")).toContainText("detected · not installed");

  // The card names the file it would write: proof the suite is nowhere near
  // ~/.claude.json or ~/.codex/config.toml.
  await expect(page.getByTestId("mcp-card-claude")).toContainText(CLAUDE_CONFIG);
  await expect(page.getByTestId("mcp-card-codex")).toContainText(CODEX_CONFIG);

  const claudeSnippet = page.getByTestId("mcp-snippet-claude");
  await expect(claudeSnippet).toContainText('"mcpServers"');
  await expect(claudeSnippet).toContainText('"localhost-aliases"');
  await expect(claudeSnippet).toContainText("packages/mcp/src/index.ts");

  const codexSnippet = page.getByTestId("mcp-snippet-codex");
  await expect(codexSnippet).toContainText("[mcp_servers.localhost_aliases]");
  await expect(codexSnippet).toContainText('command = "bun"');
  await expect(codexSnippet).toContainText("packages/mcp/src/index.ts");
});

test("one-click install writes the temp client configs and keeps a backup", async ({ page }) => {
  await page.goto("/mcp");

  await page.getByTestId("mcp-install-claude").click();
  await expect(page.getByTestId("mcp-result-claude")).toBeVisible();
  await expect(page.getByTestId("mcp-state-claude")).toContainText("installed");
  await expect(page.getByTestId("toast")).toContainText("Claude Code configured");

  const claude = JSON.parse(readClientConfig("claude") ?? "{}") as {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  };
  expect(claude.mcpServers?.["localhost-aliases"]?.command).toBe("bun");
  expect(claude.mcpServers?.["localhost-aliases"]?.args[0]).toContain("packages/mcp/src/index.ts");
  // Nothing existed before, so there is nothing to back up.
  expect(existsSync(`${CLAUDE_CONFIG}.bak-1`)).toBe(false);

  await page.getByTestId("mcp-install-codex").click();
  await expect(page.getByTestId("mcp-result-codex")).toBeVisible();
  await expect(page.getByTestId("mcp-state-codex")).toContainText("installed");

  const codex = readClientConfig("codex") ?? "";
  expect(codex).toContain("[mcp_servers.localhost_aliases]");
  // Everything we do not own is preserved verbatim.
  expect(codex).toContain("# my own settings");
  expect(codex).toContain('persistence = "save-all"');
  expect(existsSync(`${CODEX_CONFIG}.bak-1`)).toBe(true);

  // Re-installing is idempotent apart from the numbered backup.
  await page.getByTestId("mcp-install-codex").click();
  await expect.poll(() => existsSync(`${CODEX_CONFIG}.bak-2`)).toBe(true);
  const reinstalled = readClientConfig("codex") ?? "";
  expect(reinstalled.match(/\[mcp_servers\.localhost_aliases\]/g)).toHaveLength(1);
});
