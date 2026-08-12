import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, configPath } from "../src/paths.ts";
import { DEFAULT_CONFIG, ValidationError, type Config } from "../src/types.ts";
import {
  createAlias,
  deleteAlias,
  getAlias,
  listAliases,
  loadConfig,
  saveConfig,
  updateAlias,
  updateSettings,
  withConfigLock,
} from "../src/store.ts";

const ORIGINAL_CONFIG_DIR = process.env.LA_CONFIG_DIR;
const roots: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "la-store-"));
  roots.push(root);
  process.env.LA_CONFIG_DIR = root;
  // Guard: no test may ever be allowed to touch the real ~/.config.
  expect(configDir()).toBe(root);
});

afterEach(() => {
  process.env.LA_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

afterAll(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.LA_CONFIG_DIR;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function readRawConfig(): Promise<unknown> {
  return JSON.parse(await Bun.file(configPath()).text());
}

describe("loadConfig", () => {
  test("seeds defaults on first read and persists them", async () => {
    const config = await loadConfig();
    expect(config).toEqual({ ...DEFAULT_CONFIG, aliases: [] });
    expect(await Bun.file(configPath()).exists()).toBe(true);
    expect(await readRawConfig()).toEqual({ ...DEFAULT_CONFIG, aliases: [] });
  });

  test("is stable across reads", async () => {
    const first = await loadConfig();
    const second = await loadConfig();
    expect(second).toEqual(first);
  });

  test("fills in missing fields with defaults", async () => {
    await Bun.write(configPath(), JSON.stringify({ version: 1, tld: "test" }));
    const config = await loadConfig();
    expect(config.tld).toBe("test");
    expect(config.httpPort).toBe(DEFAULT_CONFIG.httpPort);
    expect(config.dashboardPort).toBe(DEFAULT_CONFIG.dashboardPort);
    expect(config.aliases).toEqual([]);
  });

  test("replaces nonsensical scalar values with defaults", async () => {
    await Bun.write(
      configPath(),
      JSON.stringify({ tld: "-nope-", httpPort: "eighty", https: "yes", dashboardPort: 0 }),
    );
    const config = await loadConfig();
    expect(config.tld).toBe(DEFAULT_CONFIG.tld);
    expect(config.httpPort).toBe(DEFAULT_CONFIG.httpPort);
    expect(config.https).toBe(DEFAULT_CONFIG.https);
    expect(config.dashboardPort).toBe(DEFAULT_CONFIG.dashboardPort);
  });

  test("keeps sane aliases and drops broken ones", async () => {
    await Bun.write(
      configPath(),
      JSON.stringify({
        version: 1,
        aliases: [
          { id: "a", name: "Good", port: 3000 },
          { id: "b", name: "no-port" },
          { id: "c", name: "bad name!", port: 3001 },
          { id: "d", name: "over", port: 70000 },
          "not-an-object",
          null,
          { id: "e", name: "dupe", port: 3002 },
          { id: "f", name: "DUPE", port: 3003 },
        ],
      }),
    );
    const config = await loadConfig();
    expect(config.aliases.map((a) => a.name)).toEqual(["good", "dupe"]);
    const first = config.aliases[0]!;
    expect(first.target).toBe("127.0.0.1");
    expect(first.enabled).toBe(true);
    expect(first.projectPath).toBeNull();
    expect(first.description).toBeNull();
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
  });

  test("generates an id for an alias that lost one", async () => {
    await Bun.write(
      configPath(),
      JSON.stringify({ version: 1, aliases: [{ name: "myapp", port: 3000 }] }),
    );
    const config = await loadConfig();
    expect(config.aliases[0]!.id.length).toBeGreaterThan(0);
  });

  test("backs up unparseable JSON and starts fresh", async () => {
    await Bun.write(configPath(), "{ this is not json");
    const config = await loadConfig();
    expect(config).toEqual({ ...DEFAULT_CONFIG, aliases: [] });
    expect(await Bun.file(`${configPath()}.bak`).text()).toBe("{ this is not json");
  });

  test.each([
    ["an array root", "[1, 2, 3]"],
    ["a scalar root", '"nope"'],
    ["a non-array aliases field", '{"version":1,"aliases":{"a":1}}'],
  ])("backs up %s and starts fresh", async (_label, content) => {
    await Bun.write(configPath(), content);
    const config = await loadConfig();
    expect(config).toEqual({ ...DEFAULT_CONFIG, aliases: [] });
    expect(await Bun.file(`${configPath()}.bak`).text()).toBe(content);
    expect(await readRawConfig()).toEqual({ ...DEFAULT_CONFIG, aliases: [] });
  });
});

describe("saveConfig", () => {
  test("round-trips and leaves no temp files behind", async () => {
    const config: Config = { ...DEFAULT_CONFIG, tld: "test", aliases: [] };
    expect(await saveConfig(config)).toEqual(config);
    expect(await readRawConfig()).toEqual(config);
    const entries = await readdir(configDir());
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual(["config.json"]);
  });

  test("creates the config directory when it does not exist", async () => {
    const nested = join(process.env.LA_CONFIG_DIR!, "deep", "deeper");
    process.env.LA_CONFIG_DIR = nested;
    await saveConfig({ ...DEFAULT_CONFIG, aliases: [] });
    expect(await Bun.file(configPath()).exists()).toBe(true);
  });
});

describe("createAlias", () => {
  test("normalizes, defaults and persists", async () => {
    const { config, alias } = await createAlias({ name: "  MyApp  ", port: 3000 });
    expect(alias.name).toBe("myapp");
    expect(alias.target).toBe("127.0.0.1");
    expect(alias.enabled).toBe(true);
    expect(alias.projectPath).toBeNull();
    expect(alias.description).toBeNull();
    expect(alias.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(alias.createdAt).toBe(alias.updatedAt);
    expect(config.aliases).toEqual([alias]);
    expect((await readRawConfig() as Config).aliases).toEqual([alias]);
  });

  test("keeps the optional fields it is given", async () => {
    const { alias } = await createAlias({
      name: "api",
      port: 8080,
      target: "::1",
      projectPath: "/Users/me/proj",
      description: "API server",
      enabled: false,
    });
    expect(alias).toMatchObject({
      name: "api",
      port: 8080,
      target: "::1",
      projectPath: "/Users/me/proj",
      description: "API server",
      enabled: false,
    });
  });

  test("generates unique ids", async () => {
    const a = await createAlias({ name: "one", port: 3001 });
    const b = await createAlias({ name: "two", port: 3002 });
    expect(a.alias.id).not.toBe(b.alias.id);
  });

  test.each([
    ["duplicate name", { name: "myapp", port: 4000 }],
    ["duplicate name in another case", { name: "MYAPP", port: 4000 }],
    ["reserved name", { name: "localhost", port: 4000 }],
    ["invalid name", { name: "my_app", port: 4000 }],
    ["port too low", { name: "other", port: 0 }],
    ["port too high", { name: "other", port: 65536 }],
    ["remote target", { name: "other", port: 4000, target: "example.com" }],
  ])("rejects %s without writing", async (_label, input) => {
    await createAlias({ name: "myapp", port: 3000 });
    const before = await Bun.file(configPath()).text();
    await expect(createAlias(input)).rejects.toThrow(ValidationError);
    expect(await Bun.file(configPath()).text()).toBe(before);
  });
});

describe("getAlias / listAliases", () => {
  test("finds by id and by bare name, case-insensitively", async () => {
    const { alias } = await createAlias({ name: "myapp", port: 3000 });
    expect((await getAlias(alias.id))?.id).toBe(alias.id);
    expect((await getAlias("myapp"))?.id).toBe(alias.id);
    expect((await getAlias("MyApp"))?.id).toBe(alias.id);
    expect(await getAlias("nope")).toBeNull();
    expect(await getAlias("")).toBeNull();
  });

  test("listAliases returns everything in insertion order", async () => {
    await createAlias({ name: "one", port: 3001 });
    await createAlias({ name: "two", port: 3002 });
    expect((await listAliases()).map((a) => a.name)).toEqual(["one", "two"]);
  });
});

describe("updateAlias", () => {
  test("patches only the given fields and bumps updatedAt", async () => {
    const { alias } = await createAlias({ name: "myapp", port: 3000, description: "keep" });
    await Bun.sleep(2);
    const { alias: updated } = await updateAlias(alias.id, { port: 4000 });
    expect(updated.port).toBe(4000);
    expect(updated.name).toBe("myapp");
    expect(updated.description).toBe("keep");
    expect(updated.createdAt).toBe(alias.createdAt);
    expect(updated.updatedAt).not.toBe(alias.updatedAt);
  });

  test("can clear nullable fields explicitly", async () => {
    const { alias } = await createAlias({
      name: "myapp",
      port: 3000,
      description: "gone",
      projectPath: "/tmp/x",
    });
    const { alias: updated } = await updateAlias(alias.id, {
      description: null,
      projectPath: null,
    });
    expect(updated.description).toBeNull();
    expect(updated.projectPath).toBeNull();
  });

  test("allows keeping its own name", async () => {
    const { alias } = await createAlias({ name: "myapp", port: 3000 });
    const { alias: updated } = await updateAlias(alias.id, { name: "MyApp", port: 3001 });
    expect(updated.name).toBe("myapp");
  });

  test("rejects a name taken by another alias", async () => {
    await createAlias({ name: "taken", port: 3000 });
    const { alias } = await createAlias({ name: "myapp", port: 3001 });
    await expect(updateAlias(alias.id, { name: "TAKEN" })).rejects.toThrow(ValidationError);
  });

  test("rejects an unknown id", async () => {
    await expect(updateAlias("missing", { port: 3000 })).rejects.toThrow(/not found/i);
  });

  test("persists the change", async () => {
    const { alias } = await createAlias({ name: "myapp", port: 3000 });
    await updateAlias(alias.id, { enabled: false });
    expect((await getAlias(alias.id))?.enabled).toBe(false);
  });
});

describe("deleteAlias", () => {
  test("removes the alias and returns it", async () => {
    const { alias } = await createAlias({ name: "myapp", port: 3000 });
    await createAlias({ name: "other", port: 3001 });
    const { config, alias: deleted } = await deleteAlias(alias.id);
    expect(deleted.id).toBe(alias.id);
    expect(config.aliases.map((a) => a.name)).toEqual(["other"]);
    expect(await getAlias(alias.id)).toBeNull();
  });

  test("rejects an unknown id", async () => {
    await expect(deleteAlias("missing")).rejects.toThrow(/not found/i);
  });
});

describe("updateSettings", () => {
  test("patches settings and leaves aliases alone", async () => {
    await createAlias({ name: "myapp", port: 3000 });
    const config = await updateSettings({ tld: "TEST.", https: true, httpsPort: 8443 });
    expect(config.tld).toBe("test");
    expect(config.https).toBe(true);
    expect(config.httpsPort).toBe(8443);
    expect(config.httpPort).toBe(DEFAULT_CONFIG.httpPort);
    expect(config.aliases.length).toBe(1);
  });

  test("ignores fields that are not provided", async () => {
    await updateSettings({ tld: "test" });
    const config = await updateSettings({ dashboardPort: 9000 });
    expect(config.tld).toBe("test");
    expect(config.dashboardPort).toBe(9000);
  });

  test("reports a bad port on its own field", async () => {
    try {
      await updateSettings({ httpPort: 0 });
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]!.field).toBe("httpPort");
    }
  });

  test("rejects an invalid tld without writing", async () => {
    const before = await loadConfig();
    await expect(updateSettings({ tld: "-nope-" })).rejects.toThrow(ValidationError);
    expect(await loadConfig()).toEqual(before);
  });
});

describe("withConfigLock", () => {
  test("serializes overlapping tasks", async () => {
    const events: string[] = [];
    const task = (id: string) =>
      withConfigLock(async () => {
        events.push(`${id}:start`);
        await Bun.sleep(5);
        events.push(`${id}:end`);
      });
    await Promise.all([task("a"), task("b"), task("c")]);
    expect(events).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  test("a failing task does not wedge the queue", async () => {
    await expect(
      withConfigLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withConfigLock(async () => "next")).toBe("next");
  });

  test("concurrent createAlias calls never lose a write", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `app-${i}`);
    await Promise.all(names.map((name, i) => createAlias({ name, port: 3000 + i })));
    const aliases = await listAliases();
    expect(aliases.length).toBe(25);
    expect(new Set(aliases.map((a) => a.name)).size).toBe(25);
    expect((await readRawConfig() as Config).aliases.length).toBe(25);
  });

  test("concurrent createAlias with the same name lets exactly one win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createAlias({ name: "clash", port: 3000 })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await listAliases()).length).toBe(1);
  });

  test("concurrent deletes leave the config consistent", async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createAlias({ name: `app-${i}`, port: 3000 + i })),
    );
    await Promise.all(created.slice(0, 3).map(({ alias }) => deleteAlias(alias.id)));
    expect((await listAliases()).map((a) => a.name)).toEqual(["app-3", "app-4", "app-5"]);
  });
});
