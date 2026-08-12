/**
 * Server-layer unit tests.
 *
 * Everything runs against a throwaway LA_CONFIG_DIR with **no helper installed**
 * (LA_SOCKET_PATH points at a path that will never exist), which is exactly the
 * first-run state the dashboard has to survive: every mutation must still persist
 * and come back with a non-fatal warning.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, WORKSPACE_FILENAME } from "@localhost-aliases/core";
import {
  parseCreateAlias,
  parseLinkProject,
  parseMcpInstall,
  parseSettingsPatch,
  parseUpdateAlias,
  readJsonBody,
} from "../lib/input.ts";
import {
  applyNow,
  createAliasFlow,
  deleteAliasFlow,
  getMcp,
  getSettings,
  getStatus,
  installMcpClient,
  linkProject,
  listAliasViews,
  listProjects,
  updateAliasFlow,
  updateSettingsFlow,
} from "../lib/service.ts";
import { toErrorResponse } from "../lib/http.ts";

let root: string;
let projectDir: string;

/** Ports nothing sane listens on, so probes resolve instantly as "down". */
const PORT_A = 59321;
const PORT_B = 59322;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "la-web-test-"));
  projectDir = join(root, "project");
  await mkdir(projectDir, { recursive: true });

  process.env.LA_CONFIG_DIR = join(root, "config");
  process.env.LA_SOCKET_PATH = join(root, "missing.sock");
  process.env.LA_CLAUDE_CONFIG = join(root, "claude.json");
  process.env.LA_CODEX_CONFIG = join(root, "codex", "config.toml");
  process.env.LA_HOSTS_PATH = join(root, "hosts");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function issuesOf(error: unknown): { field: string; message: string }[] {
  return (error as { issues?: { field: string; message: string }[] }).issues ?? [];
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// ---------------------------------------------------------------------------

describe("aliases", () => {
  test("a create survives the helper being absent and reports a warning", async () => {
    const { value, warning } = await createAliasFlow({ name: "MyApp", port: PORT_A });

    expect(value.name).toBe("myapp");
    expect(value.hostname).toBe("myapp.local");
    expect(value.url).toBe("http://myapp.local");
    expect(value.target).toBe("127.0.0.1");
    expect(value.enabled).toBe(true);
    expect(warning).toContain("saved");

    // The write is on disk, not just in the response.
    const config = await loadConfig();
    expect(config.aliases.map((a) => a.name)).toEqual(["myapp"]);
  });

  test("a duplicate name is a validation error carrying field-level issues", async () => {
    await createAliasFlow({ name: "dup", port: PORT_A });
    const error = await expectRejection(createAliasFlow({ name: "DUP", port: PORT_B }));

    expect((error as Error).name).toBe("ValidationError");
    expect(issuesOf(error)[0]?.field).toBe("name");
    expect(toErrorResponse(error).status).toBe(400);
  });

  test("reserved names are refused", async () => {
    const error = await expectRejection(createAliasFlow({ name: "localhost", port: PORT_A }));
    expect(issuesOf(error)[0]?.message).toContain("reserved");
  });

  test("update renames and re-points an alias", async () => {
    const created = await createAliasFlow({ name: "one", port: PORT_A });
    const { value } = await updateAliasFlow(created.value.id, { name: "two", port: PORT_B });

    expect(value.name).toBe("two");
    expect(value.port).toBe(PORT_B);
    expect(value.id).toBe(created.value.id);
    expect((await listAliasViews()).map((a) => a.name)).toEqual(["two"]);
  });

  test("update and delete on an unknown id are not-found errors", async () => {
    const update = await expectRejection(updateAliasFlow("nope", { port: PORT_B }));
    const remove = await expectRejection(deleteAliasFlow("nope"));

    expect((update as Error).name).toBe("NotFoundError");
    expect((remove as Error).name).toBe("NotFoundError");
    expect(toErrorResponse(update).status).toBe(404);
  });

  test("delete removes the alias from disk", async () => {
    const created = await createAliasFlow({ name: "gone", port: PORT_A });
    const { value } = await deleteAliasFlow(created.value.id);

    expect(value.name).toBe("gone");
    expect(await listAliasViews()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("settings", () => {
  test("changing the tld re-derives every hostname", async () => {
    await createAliasFlow({ name: "app", port: PORT_A });
    const { value, warning } = await updateSettingsFlow({ tld: "Test" });

    expect(value.tld).toBe("test");
    expect(warning).toContain("saved");
    expect((await listAliasViews())[0]?.hostname).toBe("app.test");
    expect(await getSettings()).toMatchObject({ tld: "test", httpPort: 80 });
  });

  test("an invalid tld is rejected without touching the stored config", async () => {
    const error = await expectRejection(updateSettingsFlow({ tld: "-bad-" }));
    expect(issuesOf(error)[0]?.field).toBe("tld");
    expect((await getSettings()).tld).toBe("local");
  });

  test("a bad port reports the offending field", async () => {
    const error = await expectRejection(updateSettingsFlow({ httpPort: 0 }));
    expect(issuesOf(error)[0]?.field).toBe("httpPort");
  });
});

// ---------------------------------------------------------------------------

describe("status and apply", () => {
  test("status is fully populated with no helper installed", async () => {
    await createAliasFlow({ name: "app", port: PORT_A });
    const status = await getStatus();

    expect(status.helper.running).toBe(false);
    expect(typeof status.helper.reason).toBe("string");
    expect(status.helper.status).toBeNull();
    expect(status.ca).toEqual({ generated: false, trusted: false, path: null });
    expect(status.aliasCount).toBe(1);
    expect(status.tld).toBe("local");
    expect(status.mcp.claude.installed).toBe(false);
    expect(status.mcp.codex.clientDetected).toBe(false);
    expect(status.commands.install).toContain("install.sh");
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("apply degrades to applied:false with a warning", async () => {
    await createAliasFlow({ name: "app", port: PORT_A });
    const outcome = await applyNow();

    expect(outcome.applied).toBe(false);
    expect(outcome.routes).toBe(1);
    expect(outcome.response).toBeNull();
    expect(outcome.warning).toContain("helper");
  });

  test("disabled aliases are not routed", async () => {
    const created = await createAliasFlow({ name: "app", port: PORT_A });
    await updateAliasFlow(created.value.id, { enabled: false });
    expect((await applyNow()).routes).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("projects", () => {
  test("aliases are grouped by project path", async () => {
    await createAliasFlow({ name: "web", port: PORT_A, projectPath: projectDir });
    await createAliasFlow({ name: "api", port: PORT_B, projectPath: projectDir });
    await createAliasFlow({ name: "loose", port: 59323 });

    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.path).toBe(projectDir);
    expect(projects[0]?.name).toBe("project");
    expect(projects[0]?.hasWorkspaceFile).toBe(false);
    expect(projects[0]?.aliases.map((a) => a.name).sort()).toEqual(["api", "web"]);
  });

  test("link writes the workspace file and registers the aliases", async () => {
    const { value, warning } = await linkProject(projectDir, [
      { name: "site", port: PORT_A, description: "front end" },
      { name: "api", port: PORT_B },
    ]);

    expect(value.created.sort()).toEqual(["api", "site"]);
    expect(value.project.hasWorkspaceFile).toBe(true);
    expect(value.project.aliases).toHaveLength(2);
    expect(warning).toContain("saved");

    const file = JSON.parse(await Bun.file(join(projectDir, WORKSPACE_FILENAME)).text());
    expect(file.aliases.map((a: { name: string }) => a.name)).toEqual(["api", "site"]);

    const stored = await loadConfig();
    expect(stored.aliases.every((a) => a.projectPath === projectDir)).toBe(true);
  });

  test("linking an existing alias re-points it instead of failing", async () => {
    const created = await createAliasFlow({ name: "site", port: PORT_A });
    const { value } = await linkProject(projectDir, [{ name: "site", port: PORT_B }]);

    expect(value.created).toEqual([]);
    expect(value.updated).toEqual(["site"]);
    const stored = await loadConfig();
    expect(stored.aliases).toHaveLength(1);
    expect(stored.aliases[0]?.id).toBe(created.value.id);
    expect(stored.aliases[0]?.port).toBe(PORT_B);
    expect(stored.aliases[0]?.projectPath).toBe(projectDir);
  });

  test("a missing path, a file and a relative path are all validation errors", async () => {
    const filePath = join(root, "a-file");
    await writeFile(filePath, "x");

    for (const [path, fragment] of [
      [join(root, "nope"), "does not exist"],
      [filePath, "is not a directory"],
      ["relative/dir", "absolute"],
    ] as const) {
      const error = await expectRejection(linkProject(path, [{ name: "x", port: PORT_A }]));
      expect(issuesOf(error)[0]?.field).toBe("path");
      expect(issuesOf(error)[0]?.message).toContain(fragment);
    }
  });

  test("a malformed workspace file still counts as present", async () => {
    await createAliasFlow({ name: "web", port: PORT_A, projectPath: projectDir });
    await writeFile(join(projectDir, WORKSPACE_FILENAME), "{ not json");
    expect((await listProjects())[0]?.hasWorkspaceFile).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("mcp", () => {
  test("detection reports both clients as absent and offers snippets", async () => {
    const mcp = await getMcp();
    expect(mcp.clients.claude.clientDetected).toBe(false);
    expect(mcp.clients.codex.installed).toBe(false);
    expect(mcp.snippets.claude).toContain("localhost-aliases");
    expect(mcp.snippets.codex).toContain("[mcp_servers.localhost_aliases]");
    expect(mcp.spec?.command).toBe("bun");
    expect(mcp.reason).toBeNull();
  });

  test("installing writes the client config and flips detection", async () => {
    const outcome = await installMcpClient("claude");
    expect(outcome.configPath).toBe(process.env.LA_CLAUDE_CONFIG as string);
    expect(outcome.backupPath).toBeNull();
    expect(outcome.clients.claude.installed).toBe(true);

    const written = JSON.parse(await Bun.file(outcome.configPath).text());
    expect(written.mcpServers["localhost-aliases"].command).toBe("bun");
  });
});

// ---------------------------------------------------------------------------

describe("input parsing", () => {
  test("unknown fields are rejected", () => {
    let error: unknown;
    try {
      parseCreateAlias({ name: "a", port: 3000, colour: "red" });
    } catch (err) {
      error = err;
    }
    expect(issuesOf(error)[0]).toEqual({ field: "colour", message: "is not a recognized field" });
  });

  test("ports arriving as strings are coerced, garbage is not", () => {
    expect(parseCreateAlias({ name: "a", port: " 3000 " }).port).toBe(3000);
    expect(() => parseCreateAlias({ name: "a", port: "3000abc" })).toThrow();
    expect(() => parseCreateAlias({ name: "a", port: "3e3" })).toThrow();
    expect(() => parseCreateAlias({ name: "a", port: true })).toThrow();
    expect(() => parseCreateAlias({ name: "a", port: 30.5 })).toThrow();
    expect(() => parseCreateAlias({ port: 3000 })).toThrow();
  });

  test("empty strings become null and explicit null survives", () => {
    expect(parseCreateAlias({ name: "a", port: 1, description: "  " }).description).toBeNull();
    expect(parseUpdateAlias({ projectPath: null }).projectPath).toBeNull();
    expect(parseUpdateAlias({}).name).toBeUndefined();
  });

  test("a settings patch must contain at least one known setting", () => {
    expect(() => parseSettingsPatch({})).toThrow();
    expect(() => parseSettingsPatch({ tld: "dev", nope: 1 })).toThrow();
    expect(parseSettingsPatch({ httpPort: "8080" }).httpPort).toBe(8080);
  });

  test("link payloads are validated entry by entry", () => {
    let error: unknown;
    try {
      parseLinkProject({
        path: "/tmp",
        aliases: [{ name: "ok", port: 1 }, { name: "Bad Name!", port: "x" }, { name: "ok", port: 2 }],
      });
    } catch (err) {
      error = err;
    }
    const fields = issuesOf(error).map((i) => i.field);
    expect(fields).toContain("aliases[1].name");
    expect(fields).toContain("aliases[1].port");
    expect(fields).toContain("aliases[2].name");
  });

  test("the mcp client id is an enum", () => {
    expect(parseMcpInstall({ client: "codex" })).toBe("codex");
    expect(() => parseMcpInstall({ client: "cursor" })).toThrow();
  });

  test("bodies must be JSON objects", async () => {
    expect(await readJsonBody(new Request("http://x", { method: "POST" }))).toEqual({});
    await expect(
      readJsonBody(new Request("http://x", { method: "POST", body: "[]" })),
    ).rejects.toThrow();
    await expect(
      readJsonBody(new Request("http://x", { method: "POST", body: "{oops" })),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("http mapping", () => {
  test("an unexpected error becomes a generic 500", async () => {
    const response = toErrorResponse(new Error("boom: /secret/path"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal server error.");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
