/** Assembles the MCP server. Kept transport-free so tests can drive it directly. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serverInstructions } from "./instructions.ts";
import { registerResources } from "./resources.ts";
import { registerTools } from "./tools.ts";

export const SERVER_NAME = "localhost-aliases";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "localhost-aliases" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: serverInstructions(),
    },
  );
  registerTools(server);
  registerResources(server);
  return server;
}
