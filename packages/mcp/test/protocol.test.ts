/**
 * End-to-end protocol test: spawns packages/mcp/src/index.ts as a child process
 * and speaks real MCP JSON-RPC to it over stdio.
 *
 * Three layers, deliberately:
 *   1. dashboard DOWN            — always runs; asserts the friendly, actionable error.
 *   2. stub dashboard UP         — always runs; the documented REST contract served by
 *                                  the real core store on a temp LA_CONFIG_DIR.
 *   3. real packages/web server  — skipped with a message until that package lands.
 *
 * No test here touches /etc/hosts, ~/.config or the privileged helper.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connect, freePort } from "./fixtures/mcp-harness.ts";
import { startStubDashboard } from "./fixtures/stub-dashboard.ts";
import type { StubDashboard } from "./fixtures/stub-dashboard.ts";
import { startWebDashboard } from "./fixtures/web-dashboard.ts";
import type { WebDashboard } from "./fixtures/web-dashboard.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_SERVICE = join(REPO_ROOT, "packages/web/lib/service.ts");

const TOOL_NAMES = [
  "list_aliases",
  "list_projects",
  "create_alias",
  "delete_alias",
  "link_project",
  "get_usage_instructions",
];

type Structured = Record<string, any>;

function jsonBody(contents: unknown[]): Structured {
  const first = contents[0] as { text?: string } | undefined;
  return JSON.parse(String(first?.text));
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    structuredContent?: Structured;
    isError?: boolean;
  };
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return { text, structured: (result.structuredContent ?? {}) as Structured, isError: result.isError === true };
}

// ---------------------------------------------------------------------------
// 1. Dashboard down
// ---------------------------------------------------------------------------

describe("MCP protocol — dashboard down", () => {
  let client: Client;
  let close: () => Promise<void>;
  let deadPort: number;

  beforeAll(async () => {
    deadPort = await freePort();
    const session = await connect(deadPort);
    client = session.client;
    close = session.close;
  });

  afterAll(async () => {
    await close?.();
  });

  test("initialize returns server info and transparency instructions", () => {
    expect(client.getServerVersion()?.name).toBe("localhost-aliases");
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("/etc/hosts");
    expect(instructions).toContain("127.0.0.1");
    expect(instructions).toContain("reverse proxy");
    expect(instructions).toContain(".localhost-aliases.json is entirely OPTIONAL");
    expect(instructions).toContain("list_aliases FIRST");
    expect(instructions).toContain("never changes");
  });

  test("tools/list exposes every documented tool with schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeDefined();
    }
    const create = tools.find((tool) => tool.name === "create_alias");
    expect(Object.keys(create?.inputSchema.properties ?? {}).sort()).toEqual([
      "description",
      "name",
      "port",
      "projectPath",
    ]);
    expect(create?.inputSchema.required).toEqual(["name", "port"]);
  });

  test("resources/list exposes localhost-aliases://aliases", async () => {
    const { resources } = await client.listResources();
    const aliases = resources.find((resource) => resource.uri === "localhost-aliases://aliases");
    expect(aliases).toBeDefined();
    expect(aliases?.mimeType).toBe("application/json");
  });

  test("list_aliases reports the app is not running, and how to start it", async () => {
    const { text, structured, isError } = await call(client, "list_aliases");
    expect(isError).toBe(true);
    expect(text).toContain("not reachable");
    expect(text).toContain(`http://127.0.0.1:${deadPort}`);
    expect(text).toContain("bun run dev");
    expect(text).toContain("LA_DASHBOARD_PORT");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("at async");
    expect(structured.ok).toBe(false);
    expect(structured.kind).toBe("dashboard-unreachable");
  });

  test("every dashboard-backed tool degrades the same way", async () => {
    for (const name of ["list_projects", "create_alias", "delete_alias", "link_project"]) {
      const args =
        name === "create_alias"
          ? { name: "demo", port: 3000 }
          : name === "delete_alias"
            ? { name: "demo" }
            : name === "link_project"
              ? { path: REPO_ROOT, aliases: [{ name: "demo", port: 3000 }] }
              : {};
      const { structured, isError } = await call(client, name, args);
      expect(isError).toBe(true);
      expect(structured.kind).toBe("dashboard-unreachable");
    }
  });

  test("get_usage_instructions works with no dashboard at all", async () => {
    const { text, structured, isError } = await call(client, "get_usage_instructions");
    expect(isError).toBe(false);
    expect(structured.ok).toBe(true);
    expect(text).toContain("# >>> localhost-aliases >>>");
    expect(text).toContain("The workspace file is OPTIONAL");
    expect(text).toContain("Exactly what changes on this machine");
    expect(text).toContain("It never changes");
    expect(text).toContain("Choosing between an existing alias and a new one");
    expect(text).toContain("$schema");
  });

  test("the aliases resource stays readable and explains itself", async () => {
    const { contents } = await client.readResource({ uri: "localhost-aliases://aliases" });
    expect(contents[0]?.mimeType).toBe("application/json");
    const payload = jsonBody(contents);
    expect(payload.ok).toBe(false);
    expect(payload.aliases).toEqual([]);
    expect(payload.error).toContain("not reachable");
  });
});

// ---------------------------------------------------------------------------
// 2. Stub dashboard (documented REST contract, real core store)
// ---------------------------------------------------------------------------

describe("MCP protocol — dashboard up (stub API over the real core store)", () => {
  let dashboard: StubDashboard;
  let client: Client;
  let close: () => Promise<void>;
  let configDir: string;
  let projectDir: string;

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), "la-mcp-config-"));
    projectDir = await mkdtemp(join(tmpdir(), "la-mcp-project-"));
    process.env.LA_CONFIG_DIR = configDir; // core store, in this process only
    dashboard = startStubDashboard();
    const session = await connect(dashboard.port);
    client = session.client;
    close = session.close;
  });

  afterAll(async () => {
    await close?.();
    await dashboard?.stop();
    delete process.env.LA_CONFIG_DIR;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  test("list_aliases on an empty config explains what to do next", async () => {
    const { text, structured, isError } = await call(client, "list_aliases");
    expect(isError).toBe(false);
    expect(structured.count).toBe(0);
    expect(text).toContain("No aliases are registered yet");
  });

  test("create_alias creates it and says what changed", async () => {
    const { text, structured, isError } = await call(client, "create_alias", {
      name: "acme-shop",
      port: 3000,
      projectPath: projectDir,
      description: "storefront",
    });
    expect(isError).toBe(false);
    expect(structured.alias.hostname).toBe("acme-shop.local");
    expect(structured.alias.url).toBe("http://acme-shop.local");
    expect(structured.alias.port).toBe(3000);
    expect(structured.alias.projectPath).toBe(projectDir);
    expect(text).toContain("Created acme-shop.local -> 127.0.0.1:3000");
    expect(text).toContain("/etc/hosts");
    expect(text).toContain("were not touched");
  });

  test("list_aliases then shows it, structured and rendered", async () => {
    const { text, structured } = await call(client, "list_aliases");
    expect(structured.count).toBe(1);
    expect(structured.aliases[0].name).toBe("acme-shop");
    expect(structured.aliases[0].status).toBe("down");
    expect(structured.dashboardUrl).toBe(`http://127.0.0.1:${dashboard.port}`);
    expect(text).toContain("acme-shop.local");
    expect(text).toContain("-> 127.0.0.1:3000");
  });

  test("the aliases resource returns the same list as JSON", async () => {
    const { contents } = await client.readResource({ uri: "localhost-aliases://aliases" });
    const payload = jsonBody(contents);
    expect(payload.ok).toBe(true);
    expect(payload.aliases).toHaveLength(1);
    expect(payload.aliases[0].hostname).toBe("acme-shop.local");
  });

  test("a duplicate name surfaces field-level validation issues, not a stack trace", async () => {
    const { text, structured, isError } = await call(client, "create_alias", {
      name: "acme-shop",
      port: 4000,
    });
    expect(isError).toBe(true);
    expect(structured.kind).toBe("invalid-input");
    expect(structured.status).toBe(400);
    expect(structured.issues.length).toBeGreaterThan(0);
    expect(structured.issues[0].field).toBe("name");
    expect(text).toContain("Field issues:");
    expect(text).toContain("name:");
  });

  test("an illegal name is rejected with the reason", async () => {
    const { structured, isError } = await call(client, "create_alias", { name: "Bad_Name", port: 3001 });
    expect(isError).toBe(true);
    expect(structured.kind).toBe("invalid-input");
    expect(structured.issues.some((issue: Structured) => issue.field === "name")).toBe(true);
  });

  test("input schema violations are caught before the API is called", async () => {
    const { text, isError } = await call(client, "create_alias", { name: "nope", port: 70000 });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain("invalid");
  });

  test("list_projects groups by folder and reports the optional workspace file", async () => {
    const { text, structured, isError } = await call(client, "list_projects");
    expect(isError).toBe(false);
    expect(structured.count).toBe(1);
    expect(structured.projects[0].path).toBe(projectDir);
    expect(structured.projects[0].hasWorkspaceFile).toBe(false);
    expect(text).toContain("optional");
  });

  test("link_project registers new aliases, reuses existing ones and writes the workspace file", async () => {
    const { text, structured, isError } = await call(client, "link_project", {
      path: projectDir,
      aliases: [
        { name: "acme-shop", port: 3000, description: "storefront" },
        { name: "acme-api", port: 4000 },
      ],
    });
    expect(isError).toBe(false);
    expect(structured.created).toBe(1);
    expect(structured.reused).toBe(1);
    expect(structured.failed).toBe(0);
    expect(structured.workspaceFile).toBe(join(projectDir, ".localhost-aliases.json"));
    expect(text).toContain("optional workspace file");

    const written = await Bun.file(structured.workspaceFile).json();
    expect(written.aliases.map((entry: Structured) => entry.name)).toEqual(["acme-api", "acme-shop"]);
    expect(written.$schema).toContain("workspace-v1.json");
  });

  test("link_project is idempotent and list_projects now sees the workspace file", async () => {
    const again = await call(client, "link_project", {
      path: projectDir,
      aliases: [{ name: "acme-api", port: 4000 }],
    });
    expect(again.structured.created).toBe(0);
    expect(again.structured.reused).toBe(1);

    const { structured } = await call(client, "list_projects");
    expect(structured.projects[0].hasWorkspaceFile).toBe(true);
    expect(structured.projects[0].aliases).toHaveLength(2);
  });

  test("link_project refuses a relative path and writes nothing", async () => {
    const { text, structured, isError } = await call(client, "link_project", {
      path: "some/relative/dir",
      aliases: [{ name: "nope", port: 5000 }],
    });
    expect(isError).toBe(true);
    expect(structured.kind).toBe("invalid-input");
    expect(text).toContain("absolute");
    expect(existsSync(join(process.cwd(), "some/relative/dir"))).toBe(false);
  });

  test("delete_alias needs a name or an id", async () => {
    const { text, structured, isError } = await call(client, "delete_alias", {});
    expect(isError).toBe(true);
    expect(structured.kind).toBe("invalid-input");
    expect(text).toContain("{ name, id }");
  });

  test("delete_alias on an unknown name lists what does exist", async () => {
    const { text, structured, isError } = await call(client, "delete_alias", { name: "ghost" });
    expect(isError).toBe(true);
    expect(structured.kind).toBe("not-found");
    expect(text).toContain("acme-shop.local");
  });

  test("delete_alias accepts the full hostname and removes it", async () => {
    const { text, structured, isError } = await call(client, "delete_alias", { name: "acme-shop.local" });
    expect(isError).toBe(false);
    expect(structured.deleted.name).toBe("acme-shop");
    expect(text).toContain("Deleted acme-shop.local");

    const after = await call(client, "list_aliases");
    expect(after.structured.aliases.map((alias: Structured) => alias.name)).toEqual(["acme-api"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The real packages/web server (lands in parallel)
// ---------------------------------------------------------------------------

const webReady = existsSync(WEB_SERVICE);
if (!webReady) {
  console.warn(
    `[skip] packages/web/lib/service.ts does not exist yet, so the real-dashboard suite is skipped. ` +
      `The stub-dashboard suite above covers the same MCP surface against the documented REST contract.`,
  );
}

describe.skipIf(!webReady)("MCP protocol — real packages/web dashboard", () => {
  let web: WebDashboard | undefined;
  let client: Client;
  let close: () => Promise<void>;
  let configDir: string;
  let port: number;

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), "la-mcp-web-"));
    port = await freePort();
    // Its own build tree, so running the tests can never delete the production .next build.
    web = await startWebDashboard({ port, configDir });

    const session = await connect(port);
    client = session.client;
    close = session.close;
  }, 210_000);

  afterAll(async () => {
    await close?.();
    await web?.stop();
    await rm(configDir, { recursive: true, force: true });
  });

  test("create_alias then list_aliases against the real API", async () => {
    const created = await call(client, "create_alias", { name: "mcp-e2e", port: 4321 });
    expect(created.isError).toBe(false);
    expect(created.structured.alias.hostname).toBe("mcp-e2e.local");

    const listed = await call(client, "list_aliases");
    expect(listed.isError).toBe(false);
    expect(listed.structured.aliases.map((alias: Structured) => alias.name)).toContain("mcp-e2e");
    expect(listed.text).toContain("mcp-e2e.local");
  }, 60_000);

  test("delete_alias removes it again", async () => {
    const deleted = await call(client, "delete_alias", { name: "mcp-e2e" });
    expect(deleted.isError).toBe(false);
    const listed = await call(client, "list_aliases");
    expect(listed.structured.aliases.map((alias: Structured) => alias.name)).not.toContain("mcp-e2e");
  }, 60_000);
});
