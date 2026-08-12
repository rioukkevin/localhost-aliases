/**
 * Spawns packages/mcp/src/index.ts as a real child process and speaks MCP
 * JSON-RPC to it over stdio, exactly like a coding agent would.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export interface McpSession {
  client: Client;
  close: () => Promise<void>;
}

/** `dashboardPort` is handed to the child as LA_DASHBOARD_PORT. */
export async function connect(dashboardPort: number): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath, // bun
    args: ["run", SERVER_ENTRY],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LA_DASHBOARD_PORT: String(dashboardPort),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** A port with nothing on it, used both for "server down" and to pre-book a port. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = Number(probe.port);
  await probe.stop(true);
  return port;
}
