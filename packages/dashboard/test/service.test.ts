import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError, buildDesiredState, loadConfig, type DesiredState, type Route } from "@localhost-aliases/core";
import { NotFoundError } from "../lib/http.ts";
import {
  createAliasAndSync,
  deleteAliasAndSync,
  getAliasView,
  getHealth,
  getMcpState,
  getState,
  getStatus,
  installMcpClient,
  linkProject,
  listAliases,
  listProjects,
  prepareApply,
  sync,
  updateAliasAndSync,
  updateSettingsAndSync,
  writeProjectWorkspaceFile,
} from "../lib/service.ts";
import { appliedProbes, sandbox, stubProbes, type Sandbox } from "./helpers.ts";

let box: Sandbox;
/** Nothing applied on the machine: the state every fresh install starts from. */
const bare = { probes: stubProbes(), probeStatuses: false as const };

beforeEach(async () => {
  box = await sandbox();
});
afterEach(() => box.cleanup());

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("sync", () => {
  test("writes desired-state.json and routes.json from the config", async () => {
    const { desired } = await sync(bare);

    const onDisk = (await readJson(join(box.configDir, "desired-state.json"))) as DesiredState;
    const routes = (await readJson(join(box.configDir, "routes.json"))) as Route[];

    expect(onDisk).toEqual(desired);
    expect(routes).toEqual(desired.routes);
    // The seeded dashboard alias owns the first pool address and listens on 80.
    expect(routes[0]).toEqual({ ip: "127.0.0.2", listenPort: 80, targetPort: 7788, hostname: "index.test" });
  });

  test("reports the admin prompt when nothing has been applied yet", async () => {
    const { report } = await sync(bare);
    expect(report.needsPrompt).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.intent.required).toBe(true);
    expect(report.intent.command).toEqual([report.intent.script, join(box.configDir, "desired-state.json")]);
    expect(report.intent.script).toContain("apply.sh");
  });

  test("reports nothing to do once the machine matches", async () => {
    const config = await loadConfig();
    const probes = appliedProbes(buildDesiredState(config));
    const { report } = await sync({ probes, probeStatuses: false });

    expect(report.applied).toBe(true);
    expect(report.needsPrompt).toBe(false);
    expect(report.intent.required).toBe(false);
    expect(report.drift).toEqual([]);
  });
});

describe("aliases", () => {
  test("create returns a view and a fresh sync report", async () => {
    const { alias, sync: report } = await createAliasAndSync({ name: "Shop", port: 3000 }, bare);

    expect(alias.name).toBe("shop");
    expect(alias.hostname).toBe("shop.test");
    expect(alias.url).toBe("http://shop.test");
    expect(alias.ip).toBe("127.0.0.3");
    expect(report.needsPrompt).toBe(true);

    const routes = (await readJson(join(box.configDir, "routes.json"))) as Route[];
    expect(routes.map((r) => r.hostname)).toEqual(["index.test", "shop.test"]);
  });

  test("a duplicate name is a validation error, not a 500", async () => {
    await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    await expect(createAliasAndSync({ name: "shop", port: 3001 }, bare)).rejects.toBeInstanceOf(ValidationError);
  });

  test("a port arriving as a string from a form is accepted", async () => {
    const { alias } = await createAliasAndSync({ name: "api", port: "4000" }, bare);
    expect(alias.port).toBe(4000);
  });

  test("changing only the port needs no prompt once the forwarder is live", async () => {
    const { alias } = await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    const applied = appliedProbes(buildDesiredState(await loadConfig()));

    const { alias: updated, sync: report } = await updateAliasAndSync(
      alias.id,
      { port: 3100 },
      { probes: applied, probeStatuses: false },
    );

    expect(updated.port).toBe(3100);
    expect(report.needsPrompt).toBe(false);
    expect(report.privileged).toEqual([]);
    expect(report.unprivileged.join(" ")).toContain("now targets port 3100");
  });

  test("renaming an alias does need the prompt", async () => {
    const { alias } = await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    const applied = appliedProbes(buildDesiredState(await loadConfig()));
    const { sync: report } = await updateAliasAndSync(
      alias.id,
      { name: "store" },
      { probes: applied, probeStatuses: false },
    );

    expect(report.needsPrompt).toBe(true);
    expect(report.privileged.join(" ")).toContain("store.test");
  });

  test("an unknown id is a 404, not a validation error", async () => {
    await expect(updateAliasAndSync("nope", { port: 1234 }, bare)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteAliasAndSync("nope", bare)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getAliasView("nope", bare)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the dashboard alias refuses to be deleted", async () => {
    const [reserved] = await listAliases(bare);
    await expect(deleteAliasAndSync(reserved!.id, bare)).rejects.toBeInstanceOf(ValidationError);
  });

  test("delete removes the route as well as the alias", async () => {
    const { alias } = await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    const { deleted } = await deleteAliasAndSync(alias.id, bare);

    expect(deleted).toBe(alias.id);
    const routes = (await readJson(join(box.configDir, "routes.json"))) as Route[];
    expect(routes.map((r) => r.hostname)).toEqual(["index.test"]);
  });

  test("a listening dev server shows as up", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      const { alias } = await createAliasAndSync({ name: "live", port: server.port }, { probes: stubProbes() });
      expect(alias.status).toBe("up");

      const views = await listAliases({ probes: stubProbes() });
      expect(views.find((v) => v.name === "live")?.status).toBe("up");
    } finally {
      server.stop(true);
    }
  });
});

describe("state", () => {
  test("getState carries the capacity ceiling and the https limitation", async () => {
    const state = await getState(bare);
    expect(state.capacity).toEqual({ used: 1, total: 253, remaining: 252 });
    // https for aliases is supported now — per-IP TLS termination needs no parsing.
    // Off by default, so the state is "not enabled", not "not possible".
    expect(state.tls.enabled).toBe(false);
    expect(typeof state.tls.trustCommand).toBe("string");
    expect(state.dashboardHostname).toBe("index.test");
    expect(state.configDir).toBe(box.configDir);
  });

  test("getStatus adds the alias views the UI polls for", async () => {
    await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    const status = await getStatus(bare);
    expect(status.aliases.map((a) => a.hostname)).toEqual(["index.test", "shop.test"]);
    expect(status.system.drift.length).toBeGreaterThan(0);
  });

  test("prepareApply refreshes the files and reports the intent without running anything", async () => {
    const result = await prepareApply(bare);
    expect(result.ok).toBe(false);
    expect(result.needsPrompt).toBe(true);
    expect(result.intent.command[0]).toContain("apply.sh");
    expect(await readJson(join(box.configDir, "desired-state.json"))).toBeTruthy();
  });
});

describe("settings", () => {
  test("changing the TLD rewrites every hostname", async () => {
    await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    const { config, sync: report, restartRequired } = await updateSettingsAndSync({ tld: "internal" }, bare);

    expect(config.tld).toBe("internal");
    expect(restartRequired).toBe(false);
    expect(report.needsPrompt).toBe(true);

    const routes = (await readJson(join(box.configDir, "routes.json"))) as Route[];
    expect(routes.map((r) => r.hostname)).toEqual(["index.internal", "shop.internal"]);
  });

  test("moving the dashboard port asks for a restart and moves the reserved route", async () => {
    const { config, restartRequired } = await updateSettingsAndSync({ dashboardPort: 7999 }, bare);
    expect(restartRequired).toBe(true);
    expect(config.aliases[0]!.port).toBe(7999);

    const routes = (await readJson(join(box.configDir, "routes.json"))) as Route[];
    expect(routes[0]!.targetPort).toBe(7999);
  });

  test("an empty patch is rejected", async () => {
    await expect(updateSettingsAndSync({}, bare)).rejects.toBeInstanceOf(ValidationError);
  });

  test("an invalid TLD is rejected", async () => {
    await expect(updateSettingsAndSync({ tld: "not a tld" }, bare)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("projects", () => {
  test("aliases are grouped by folder", async () => {
    const project = join(box.dir, "shop");
    await mkdir(project, { recursive: true });
    await createAliasAndSync({ name: "shop", port: 3000, projectPath: project }, bare);
    await createAliasAndSync({ name: "shop-api", port: 3001, projectPath: project }, bare);

    const projects = await listProjects(bare);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.path).toBe(project);
    expect(projects[0]!.name).toBe("shop");
    expect(projects[0]!.hasWorkspaceFile).toBe(false);
    expect(projects[0]!.aliases.map((a) => a.name)).toEqual(["shop", "shop-api"]);
  });

  test("linking imports the aliases the folder declares", async () => {
    const project = join(box.dir, "cloned");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, ".localhost-aliases.json"),
      JSON.stringify({ aliases: [{ name: "web", port: 5173, description: "vite" }] }),
    );

    const result = await linkProject({ path: project }, bare);

    expect(result.created.map((a) => a.name)).toEqual(["web"]);
    expect(result.project.hasWorkspaceFile).toBe(true);
    expect(result.project.aliases[0]!.description).toBe("vite");
    expect(result.sync.needsPrompt).toBe(true);
  });

  test("linking existing aliases sets their folder", async () => {
    const project = join(box.dir, "app");
    await mkdir(project, { recursive: true });
    const { alias } = await createAliasAndSync({ name: "app", port: 3000 }, bare);

    const result = await linkProject({ path: project, aliasIds: [alias.id] }, bare);
    expect(result.updated.map((a) => a.id)).toEqual([alias.id]);
    expect(result.project.aliases[0]!.projectPath).toBe(project);
  });

  test("a relative or missing path is a validation error", async () => {
    await expect(linkProject({ path: "relative/path" }, bare)).rejects.toBeInstanceOf(ValidationError);
    await expect(linkProject({ path: join(box.dir, "nope") }, bare)).rejects.toBeInstanceOf(ValidationError);
    await expect(linkProject({}, bare)).rejects.toBeInstanceOf(ValidationError);
  });

  test("the dashboard alias cannot be linked to a folder", async () => {
    const project = join(box.dir, "x");
    await mkdir(project, { recursive: true });
    const [reserved] = await listAliases(bare);
    await expect(linkProject({ path: project, aliasIds: [reserved!.id] }, bare)).rejects.toBeInstanceOf(ValidationError);
  });

  test("writing a workspace file round-trips through linkProject", async () => {
    const project = join(box.dir, "round");
    await mkdir(project, { recursive: true });
    await createAliasAndSync({ name: "round", port: 4321, projectPath: project }, bare);

    const written = await writeProjectWorkspaceFile({ path: project });
    expect(written.written).toBe(true);
    expect(written.aliases).toEqual([{ name: "round", port: 4321 }]);

    const onDisk = (await readJson(join(project, ".localhost-aliases.json"))) as { aliases: unknown[] };
    expect(onDisk.aliases).toEqual([{ name: "round", port: 4321 }]);
  });

  test("writing a workspace file for a folder with no aliases is refused", async () => {
    const project = join(box.dir, "empty");
    await mkdir(project, { recursive: true });
    await expect(writeProjectWorkspaceFile({ path: project })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("mcp", () => {
  test("clients are reported as not installed before anything is written", async () => {
    const state = await getMcpState();
    expect(state.clients.map((c) => c.id)).toEqual(["claude", "codex"]);
    expect(state.configured).toBe(false);
    expect(state.codexSnippet).toContain("[mcp_servers.localhost-aliases]");
  });

  test("installing writes the client config and flips configured", async () => {
    const { mcp } = await installMcpClient({ client: "claude" });
    expect(mcp.clients.find((c) => c.id === "claude")?.configured).toBe(true);

    const written = (await readJson(process.env.LA_CLAUDE_CONFIG!)) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers["localhost-aliases"]).toBeTruthy();
  });

  test("an unknown client is a validation error", async () => {
    await expect(installMcpClient({ client: "emacs" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("health", () => {
  test("reports the runtime mode and the config directory in use", async () => {
    const health = await getHealth();
    expect(health.ok).toBe(true);
    expect(health.mode).toBe("dev");
    expect(health.configDir).toBe(box.configDir);
    expect(health.dashboardPort).toBe(7788);
  });
});
