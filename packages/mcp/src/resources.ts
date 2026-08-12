/**
 * The alias list as a readable MCP resource, for clients that prefer to attach
 * context rather than call a tool.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baseUrl, fetchAliases } from "./client.ts";
import { toAliasSummary } from "./views.ts";

export const ALIASES_URI = "localhost-aliases://aliases";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "aliases",
    ALIASES_URI,
    {
      title: "Registered localhost aliases",
      description:
        "Every alias known to localhost-aliases, as JSON: hostname, url, upstream port, project folder and live status.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await fetchAliases();
      // A dead dashboard is reported inside the JSON body rather than as a
      // protocol error, so the reading client still gets something usable.
      const payload = result.ok
        ? { ok: true, dashboardUrl: baseUrl(), aliases: result.data.map(toAliasSummary) }
        : { ok: false, dashboardUrl: baseUrl(), error: result.message, aliases: [] };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: `${JSON.stringify(payload, null, 2)}\n`,
          },
        ],
      };
    },
  );
}
