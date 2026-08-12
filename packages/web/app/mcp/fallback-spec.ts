/**
 * The snippets the MCP page renders when `GET /api/mcp` could not produce its own
 * (the API is unreachable, or core cannot find the entrypoint at all).
 *
 * Server-rendered, so it is one direct call into core — the same resolution the
 * API uses, which is why the page and the API can never disagree about the path.
 */
import { claudeSnippet, codexSnippet, mcpServerSpec } from "@localhost-aliases/core";

export interface FallbackSpec {
  entrypoint: string;
  claude: string;
  codex: string;
}

export function fallbackSpec(): FallbackSpec | null {
  try {
    const entrypoint = mcpServerSpec().args[0];
    if (entrypoint === undefined) return null;
    return { entrypoint, claude: claudeSnippet(), codex: codexSnippet() };
  } catch {
    // Core says the entrypoint is not on disk; the page shows the API's reason.
    return null;
  }
}
