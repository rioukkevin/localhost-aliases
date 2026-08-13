/** Wires the handlers into an McpServer. No transport here — see index.ts. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DashboardClient } from "./client.ts";
import { serverInstructions } from "./instructions.ts";
import * as tools from "./tools.ts";

export const SERVER_NAME = "localhost-aliases";
export const SERVER_VERSION = "2.0.0";
export const ALIASES_RESOURCE_URI = "localhost-aliases://aliases";

export function createServer(client: DashboardClient = new DashboardClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: serverInstructions() },
  );

  server.registerTool(
    "list_aliases",
    {
      title: "List aliases",
      description:
        "List every localhost alias with its hostname, target port, loopback IP and live status.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => tools.listAliases(client),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List project folders that have at least one alias linked to them.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => tools.listProjects(client),
  );

  server.registerTool(
    "create_alias",
    {
      title: "Create an alias",
      description:
        "Create http://<name>.<tld> pointing at 127.0.0.1:<port>. Triggers ONE macOS admin " +
        "prompt the user must accept (it adds a loopback IP and an /etc/hosts line). " +
        "http only: TLS cannot be terminated for project aliases.",
      inputSchema: {
        name: z
          .string()
          .describe("Host label without the TLD, e.g. \"myapp\" for myapp.local. Lowercase letters, digits and hyphens."),
        port: z.number().int().min(1).max(65535).describe("Port the dev server listens on, on 127.0.0.1."),
        projectPath: z.string().optional().describe("Absolute path of the project folder, if any."),
        description: z.string().optional().describe("Short note shown in the dashboard."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    (args) => tools.createAlias(client, args),
  );

  server.registerTool(
    "delete_alias",
    {
      title: "Delete an alias",
      description:
        "Delete an alias by hostname, name or id. Removes its /etc/hosts line and loopback IP " +
        "behind one macOS admin prompt. The reserved dashboard alias cannot be deleted.",
      inputSchema: {
        alias: z.string().describe("Hostname (myapp.local), bare name (myapp) or alias id."),
      },
      annotations: { destructiveHint: true },
    },
    (args) => tools.deleteAlias(client, args),
  );

  server.registerTool(
    "link_project",
    {
      title: "Link an alias to a project folder",
      description:
        "Attach a project folder to an alias, and import any aliases the folder declares in " +
        ".localhost-aliases.json. Linking alone is metadata; importing declared aliases can " +
        "create new ones, which needs the admin prompt.",
      inputSchema: {
        projectPath: z.string().describe("Absolute path of the project folder."),
        alias: z
          .string()
          .optional()
          .describe("Hostname (myapp.local), bare name (myapp) or alias id to attach. Omit to only import the folder's declared aliases."),
        importWorkspace: z
          .boolean()
          .optional()
          .describe("Import aliases declared in the folder's .localhost-aliases.json. Default true."),
        writeWorkspaceFile: z
          .boolean()
          .optional()
          .describe("Also write the folder's .localhost-aliases.json from the aliases now linked to it. Default false."),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (args) => tools.linkProject(client, args),
  );

  server.registerTool(
    "get_usage_instructions",
    {
      title: "How localhost aliases work",
      description:
        "The full mechanism: which files change, when the admin prompt appears, why project " +
        "aliases are http only, and where state lives. Read this before explaining anything " +
        "about aliases to the user.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => tools.usageInstructions(),
  );

  server.registerResource(
    "aliases",
    ALIASES_RESOURCE_URI,
    {
      title: "Localhost aliases",
      description: "Every configured alias as JSON, with hostname, url, port, ip and live status.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: await tools.aliasesResource(client) },
      ],
    }),
  );

  return server;
}
