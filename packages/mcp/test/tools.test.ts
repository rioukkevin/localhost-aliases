import { describe, expect, test } from "bun:test";
import { DashboardClient } from "../src/client.ts";
import * as tools from "../src/tools.ts";
import { alias, project, stubFetch } from "./stub.ts";

const BASE = "http://127.0.0.1:7788";

function setup(routes: Parameters<typeof stubFetch>[0]) {
  const { fetch, requests } = stubFetch(routes);
  return { client: new DashboardClient({ baseUrl: BASE, fetch }), requests };
}

const body = (r: tools.ToolResult) => r.content[0]!.text;

describe("list_aliases", () => {
  test("renders hostname, target, ip and status", async () => {
    const { client } = setup({
      "GET /api/aliases": { body: { aliases: [alias({ status: "up", description: "the api" })] } },
    });
    const out = body(await tools.listAliases(client));
    expect(out).toContain("myapp.test");
    expect(out).toContain("http://myapp.test -> 127.0.0.1:3000");
    expect(out).toContain("ip=127.0.0.2");
    expect(out).toContain("status=up");
    expect(out).toContain("the api");
  });

  test("marks the reserved and disabled ones", async () => {
    const { client } = setup({
      "GET /api/aliases": {
        body: { aliases: [alias({ name: "index", reserved: true }), alias({ name: "old", enabled: false })] },
      },
    });
    const out = body(await tools.listAliases(client));
    expect(out).toContain("reserved (the dashboard itself)");
    expect(out).toContain("disabled");
  });

  test("says so when there is nothing", async () => {
    const { client } = setup({ "GET /api/aliases": { body: { aliases: [] } } });
    expect(body(await tools.listAliases(client))).toBe("No aliases yet.");
  });

  test("an unreachable dashboard is an actionable tool error", async () => {
    const { client } = setup({ "GET /api/aliases": { networkError: true } });
    const result = await tools.listAliases(client);
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("open Localhost Aliases");
    expect(body(result)).not.toContain("at Object.");
  });
});

describe("list_projects", () => {
  test("nests aliases under their folder", async () => {
    const { client } = setup({
      "GET /api/projects": {
        body: { projects: [project({ hasWorkspaceFile: true, aliases: [alias({ status: "up" })] })] },
      },
    });
    const out = body(await tools.listProjects(client));
    expect(out).toContain("/Users/dev/app");
    expect(out).toContain(".localhost-aliases.json");
    expect(out).toContain("myapp.test -> 127.0.0.1:3000 (up)");
  });

  test("explains the empty case", async () => {
    const { client } = setup({ "GET /api/projects": { body: { projects: [] } } });
    expect(body(await tools.listProjects(client))).toContain("once an alias is linked");
  });
});

describe("create_alias", () => {
  test("posts the input and reports http-only plus the pending admin prompt", async () => {
    const { client, requests } = setup({
      "POST /api/aliases": {
        body: {
          alias: alias({ name: "api", port: 4000, ip: "127.0.0.3" }),
          sync: { applied: false, needsPrompt: true, privileged: ["add 127.0.0.3 to lo0"] },
        },
      },
    });
    const out = body(await tools.createAlias(client, { name: "api", port: 4000, description: "d" }));
    expect(requests[0]?.body).toEqual({ name: "api", port: 4000, projectPath: null, description: "d" });
    expect(out).toContain("Created api.test -> 127.0.0.1:4000 on 127.0.0.3");
    expect(out).toContain("http only");
    expect(out).toContain("one macOS admin prompt");
    expect(out).toContain("add 127.0.0.3 to lo0");
  });

  test("does not invent a prompt when the change is already live", async () => {
    const { client } = setup({
      "POST /api/aliases": {
        body: { alias: alias(), sync: { applied: true, needsPrompt: false, privileged: [] } },
      },
    });
    const out = body(await tools.createAlias(client, { name: "myapp", port: 3000 }));
    expect(out).toContain("already live");
    expect(out).not.toContain("admin prompt");
  });

  test("warns when nothing is listening yet", async () => {
    const { client } = setup({ "POST /api/aliases": { body: { alias: alias({ status: "down" }) } } });
    expect(body(await tools.createAlias(client, { name: "myapp", port: 3000 }))).toContain(
      "will not answer until the dev server starts",
    );
  });

  test("a rejected name surfaces the dashboard's reason", async () => {
    const { client } = setup({ "POST /api/aliases": { status: 409, body: { error: "name already used" } } });
    const result = await tools.createAlias(client, { name: "myapp", port: 3000 });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("name already used");
  });
});

describe("delete_alias", () => {
  const listing = { body: { aliases: [alias({ id: "a1" }), alias({ id: "a2", name: "index", reserved: true })] } };

  test("resolves by bare name, hostname and id", async () => {
    for (const ref of ["myapp", "myapp.test", "MyApp.Test", "a1"]) {
      const { client, requests } = setup({
        "GET /api/aliases": listing,
        "DELETE /api/aliases/a1": { body: { deleted: "a1", sync: { applied: true, needsPrompt: false, privileged: [] } } },
      });
      const out = body(await tools.deleteAlias(client, { alias: ref }));
      expect(out).toContain("Deleted myapp.test");
      expect(requests.at(-1)?.path).toBe("/api/aliases/a1");
    }
  });

  test("refuses the reserved alias without calling DELETE", async () => {
    const { client, requests } = setup({ "GET /api/aliases": listing });
    const result = await tools.deleteAlias(client, { alias: "index" });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("cannot be deleted");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("an unknown alias lists the ones that exist", async () => {
    const { client } = setup({ "GET /api/aliases": listing });
    const result = await tools.deleteAlias(client, { alias: "ghost" });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("myapp.test, index.test");
  });
});

describe("link_project", () => {
  const linked = alias({ id: "a1", projectPath: "/Users/dev/app" });
  const linkBody = {
    project: project({ aliases: [linked] }),
    created: [],
    updated: [linked],
    workspaceFile: null,
    sync: { applied: true, needsPrompt: false, privileged: [] },
  };

  test("resolves the alias to an id and posts to /api/projects/link", async () => {
    const { client, requests } = setup({
      "GET /api/aliases": { body: { aliases: [alias({ id: "a1" })] } },
      "POST /api/projects/link": { body: linkBody },
    });
    const out = body(await tools.linkProject(client, { alias: "myapp", projectPath: "/Users/dev/app" }));
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/projects/link",
      body: { path: "/Users/dev/app", aliasIds: ["a1"], importWorkspace: true, writeWorkspaceFile: false },
    });
    expect(out).toContain("/Users/dev/app");
    expect(out).toContain("http://myapp.test -> 127.0.0.1:3000");
  });

  test("works with no alias at all — importing what the folder declares", async () => {
    const created = alias({ id: "a2", name: "web", projectPath: "/Users/dev/app" });
    const { client, requests } = setup({
      "POST /api/projects/link": {
        body: { ...linkBody, project: project({ aliases: [created] }), created: [created], updated: [] },
      },
    });
    const out = body(await tools.linkProject(client, { projectPath: "/Users/dev/app" }));
    expect(requests[0]?.body).toMatchObject({ aliasIds: [] });
    expect(out).toContain("Imported 1 alias(es) declared in .localhost-aliases.json");
    expect(out).toContain("web.test");
  });

  test("reports the workspace file it wrote", async () => {
    const { client } = setup({
      "POST /api/projects/link": { body: { ...linkBody, workspaceFile: "/Users/dev/app/.localhost-aliases.json" } },
    });
    const out = body(await tools.linkProject(client, { projectPath: "/Users/dev/app", writeWorkspaceFile: true }));
    expect(out).toContain("Wrote /Users/dev/app/.localhost-aliases.json");
  });

  test("rejects a relative path before touching the API", async () => {
    const { client, requests } = setup({ "GET /api/aliases": { body: { aliases: [alias()] } } });
    const result = await tools.linkProject(client, { alias: "myapp", projectPath: "./app" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("get_usage_instructions", () => {
  test("is accurate about v2 and needs no dashboard", async () => {
    const out = body(await tools.usageInstructions());
    expect(out).toContain("http:// only");
    expect(out).toContain("ifconfig lo0 alias");
    expect(out).toContain("ONCE PER APP LAUNCH");
    expect(out).toContain("ROOT AGENT");
    expect(out).toContain("NO further prompt");
    expect(out).toContain(".localhost-aliases.json");
    expect(out).toContain("127.0.0.254");
    expect(out).toContain("not an HTTP proxy");
    expect(out).toContain("no LaunchDaemon and no sudo");
  });

  // The model reads this text and repeats it to the user. Copy from the per-change era
  // would have it promise a password dialog that no longer appears.
  test("does not promise a prompt per alias change, and discloses the standing-root tradeoff", async () => {
    const out = body(await tools.usageInstructions());
    expect(out).not.toContain("idempotent batch behind a single macOS admin prompt");
    expect(out).not.toContain("therefore prompts once");
    expect(out).not.toContain("creating and deleting aliases are not");
    expect(out).toContain("writable by the user's own account and a root process acts on it");
    expect(out).toContain("never executes");
    expect(out).toContain("Quitting the app leaves nothing running as root");
  });

  test("derives its paths instead of hardcoding them", async () => {
    const previous = { hosts: process.env.LA_HOSTS_PATH, config: process.env.LA_CONFIG_DIR };
    process.env.LA_HOSTS_PATH = "/tmp/fake-hosts";
    process.env.LA_CONFIG_DIR = "/tmp/fake-config";
    try {
      // HOSTS_PATH is a module constant, so only the lazily-resolved paths can move.
      const { mechanismSummary } = await import("../src/instructions.ts");
      expect(mechanismSummary()).toContain("/tmp/fake-config");
    } finally {
      if (previous.hosts === undefined) delete process.env.LA_HOSTS_PATH;
      else process.env.LA_HOSTS_PATH = previous.hosts;
      if (previous.config === undefined) delete process.env.LA_CONFIG_DIR;
      else process.env.LA_CONFIG_DIR = previous.config;
    }
  });
});

describe("aliases resource", () => {
  test("is the alias list as JSON", async () => {
    const { client } = setup({ "GET /api/aliases": { body: { aliases: [alias()] } } });
    const parsed = JSON.parse(await tools.aliasesResource(client)) as { aliases: Array<{ url: string }> };
    expect(parsed.aliases[0]?.url).toBe("http://myapp.test");
  });
});
