/**
 * Turns outcomes into MCP tool results.
 *
 * Every result carries both a human-readable text block and a structuredContent
 * payload. Failures are returned as `isError` results (not thrown) so the calling
 * agent reads a sentence it can act on instead of a transport-level crash.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiFailure } from "./client.ts";

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ok: true, ...structured } };
}

export function problem(text: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: false, error: text, ...structured },
    isError: true,
  };
}

/**
 * `action` completes the sentence "Could not <action>", e.g. "list aliases".
 * The three failure kinds are deliberately worded differently: an unreachable
 * dashboard is an environment problem the agent can fix, a 400 is the agent's own
 * input, and anything else is the server's fault.
 */
export function fromFailure(failure: ApiFailure, action: string): CallToolResult {
  if (failure.kind === "unreachable") {
    return problem(`Could not ${action}. ${failure.message}`, {
      kind: "dashboard-unreachable",
      dashboardUrl: failure.baseUrl,
    });
  }
  if (failure.kind === "validation") {
    const lines = failure.issues.map((issue) => `  - ${issue.field}: ${issue.message}`);
    const text = [
      `Could not ${action}: the request was rejected as invalid.`,
      failure.message,
      ...(lines.length ? ["Field issues:", ...lines] : []),
    ].join("\n");
    return problem(text, { kind: "invalid-input", status: failure.status, issues: failure.issues });
  }
  return problem(
    `Could not ${action}: the dashboard answered HTTP ${failure.status} — ${failure.message}`,
    { kind: "api-error", status: failure.status },
  );
}
