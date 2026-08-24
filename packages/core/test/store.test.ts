import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath } from "../src/paths.ts";
import {
  createAlias,
  deleteAlias,
  getAlias,
  getAliasByName,
  listAliases,
  loadConfig,
  updateAlias,
  updateSettings,
} from "../src/store.ts";
import { DEFAULT_CONFIG, RESERVED_ALIAS_NAME, ValidationError, type Config } from "../src/types.ts";

let dir: string;
const previous = process.env.LA_CONFIG_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "la-store-"));
  process.env.LA_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.LA_CONFIG_DIR;
  else process.env.LA_CONFIG_DIR = previous;
});

async function raw(): Promise<Config> {
  return JSON.parse(await readFile(configPath(), "utf8")) as Config;
}

describe("seeding", () => {
  test("creates the file with defaults and the reserved alias", async () => {
    const config = await loadConfig();
    expect(config.version).toBe(2);
    expect(config.tld).toBe(DEFAULT_CONFIG.tld);
    expect(config.dashboardPort).toBe(DEFAULT_CONFIG.dashboardPort);
    expect(config.https).toBe(DEFAULT_CONFIG.https);
    expect(config.autoApply).toBe(true);
    expect(config.aliases).toHaveLength(1);

    const index = config.aliases[0]!;
    expect(index.name).toBe(RESERVED_ALIAS_NAME);
    expect(index.reserved).toBe(true);
    expect(index.enabled).toBe(true);
    expect(index.ip).toBe("127.0.0.2");
    expect(index.port).toBe(DEFAULT_CONFIG.dashboardPort);
    expect(await raw()).toEqual(config);
  });

  test("is stable across loads", async () => {
    const first = await loadConfig();
    const second = await loadConfig();
    expect(second).toEqual(first);
  });

  test("re-adds the reserved alias if it goes missing", async () => {
    await writeFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, aliases: [] }));
    const config = await loadConfig();
    expect(config.aliases.filter((a) => a.reserved)).toHaveLength(1);
  });

  test("keeps the reserved alias on the first address when others exist", async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        ...DEFAULT_CONFIG,
        aliases: [{ id: "x", name: "myapp", port: 3000, ip: "127.0.0.2" }],
      }),
    );
    const config = await loadConfig();
    const index = config.aliases.find((a) => a.reserved)!;
    expect(index.ip).toBe("127.0.0.3");
    expect(config.aliases.find((a) => a.name === "myapp")!.ip).toBe("127.0.0.2");
  });
});

describe("autoApply", () => {
  test("a config written before the field existed reads as true, not false", async () => {
    // Exactly what is on an existing user's disk today: no autoApply key at all.
    await writeFile(
      configPath(),
      JSON.stringify({ version: 2, tld: "test", dashboardPort: 7788, https: false, aliases: [] }),
    );
    expect((await loadConfig()).autoApply).toBe(true);
    // and the field is written back, so it is visible in the file from then on.
    expect((await raw()).autoApply).toBe(true);
  });

  test("an explicit false is honoured and survives a reload", async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ ...DEFAULT_CONFIG, autoApply: false, aliases: [] }),
    );
    expect((await loadConfig()).autoApply).toBe(false);
    expect((await loadConfig()).autoApply).toBe(false);
  });

  test("a non-boolean is not a false: it falls back to the default", async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ ...DEFAULT_CONFIG, autoApply: "no", aliases: [] }),
    );
    expect((await loadConfig()).autoApply).toBe(true);
  });

  test("updateSettings toggles it and rejects a non-boolean", async () => {
    expect((await updateSettings({ autoApply: false })).autoApply).toBe(false);
    expect((await raw()).autoApply).toBe(false);
    expect((await updateSettings({ autoApply: true })).autoApply).toBe(true);
    await expect(updateSettings({ autoApply: "yes" as unknown as boolean })).rejects.toThrow(ValidationError);
  });
});

describe("corrupt config", () => {
  test("is backed up rather than crashing", async () => {
    await writeFile(configPath(), "{not json at all");
    const config = await loadConfig();
    expect(config.aliases).toHaveLength(1);

    const backups = (await readdir(dir)).filter((f) => f.includes("corrupt"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe("{not json at all");
  });

  test("junk aliases are dropped and the file repaired", async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        version: 1,
        tld: "NOPE!",
        dashboardPort: 0,
        aliases: [null, { name: "ok", port: 3000 }, { name: "noport" }, { name: "ok", port: 4000 }],
      }),
    );
    const config = await loadConfig();
    expect(config.tld).toBe("test");
    expect(config.dashboardPort).toBe(7788);
    expect(config.aliases.map((a) => a.name).sort()).toEqual(["index", "ok"]);
    // repaired on disk, not just in memory
    expect(await raw()).toEqual(config);
  });
});

describe("createAlias", () => {
  test("allocates the next free IP and sensible defaults", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000 });
    expect(alias.ip).toBe("127.0.0.3");
    expect(alias.reserved).toBe(false);
    expect(alias.enabled).toBe(true);
    expect(alias.projectPath).toBeNull();
    expect(alias.description).toBeNull();
    expect(alias.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(alias.createdAt).toBe(alias.updatedAt);
  });

  test("normalizes the name", async () => {
    const alias = await createAlias({ name: "  MyApp  ", port: 3000 });
    expect(alias.name).toBe("myapp");
  });

  test("rejects duplicates case-insensitively", async () => {
    await createAlias({ name: "myapp", port: 3000 });
    await expect(createAlias({ name: "MYAPP", port: 3001 })).rejects.toThrow(ValidationError);
  });

  test("rejects the reserved index name", async () => {
    await expect(createAlias({ name: "index", port: 3000 })).rejects.toThrow(/reserved for the dashboard/);
  });

  test("rejects a bad port without writing anything", async () => {
    await loadConfig();
    const before = await raw();
    await expect(createAlias({ name: "myapp", port: 0 })).rejects.toThrow(ValidationError);
    expect(await raw()).toEqual(before);
  });

  test("reuses freed addresses so allocation stays dense", async () => {
    const a = await createAlias({ name: "a", port: 3000 });
    const b = await createAlias({ name: "b", port: 3001 });
    expect([a.ip, b.ip]).toEqual(["127.0.0.3", "127.0.0.4"]);
    await deleteAlias(a.id);
    const c = await createAlias({ name: "c", port: 3002 });
    expect(c.ip).toBe("127.0.0.3");
  });

  test("concurrent creates all land (mutex)", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `app${i}`);
    await Promise.all(names.map((name, i) => createAlias({ name, port: 3000 + i })));
    const aliases = await listAliases();
    expect(aliases).toHaveLength(21);
    expect(new Set(aliases.map((a) => a.ip)).size).toBe(21);
    expect(new Set(aliases.map((a) => a.name)).size).toBe(21);
  });
});

describe("read helpers", () => {
  test("getAlias by id, getAliasByName, and misses", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000 });
    expect((await getAlias(alias.id))!.name).toBe("myapp");
    expect((await getAliasByName("MyApp"))!.id).toBe(alias.id);
    expect(await getAlias("nope")).toBeNull();
    expect(await getAliasByName("nope")).toBeNull();
  });
});

describe("updateAlias", () => {
  test("changes only what was passed and bumps updatedAt", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000 });
    await Bun.sleep(2);
    const updated = await updateAlias(alias.id, { port: 4000 });
    expect(updated.port).toBe(4000);
    expect(updated.name).toBe("myapp");
    expect(updated.ip).toBe(alias.ip);
    expect(updated.createdAt).toBe(alias.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(alias.updatedAt));
  });

  test("an alias keeps its IP for life", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000 });
    const renamed = await updateAlias(alias.id, { name: "other", port: 5000, enabled: false });
    expect(renamed.ip).toBe(alias.ip);
  });

  test("accepts its own name", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000 });
    expect((await updateAlias(alias.id, { name: "myapp" })).name).toBe("myapp");
  });

  test("rejects a name taken by another alias", async () => {
    await createAlias({ name: "taken", port: 3000 });
    const alias = await createAlias({ name: "myapp", port: 3001 });
    await expect(updateAlias(alias.id, { name: "taken" })).rejects.toThrow(/already exists/);
  });

  test("clears optional fields with null", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000, projectPath: "/tmp/x", description: "d" });
    const cleared = await updateAlias(alias.id, { projectPath: null, description: null });
    expect(cleared.projectPath).toBeNull();
    expect(cleared.description).toBeNull();
  });

  test("unknown id throws", async () => {
    await expect(updateAlias("nope", { port: 1 })).rejects.toThrow(ValidationError);
  });

  test("the reserved alias cannot be renamed or disabled", async () => {
    const index = (await listAliases()).find((a) => a.reserved)!;
    await expect(updateAlias(index.id, { name: "dashboard" })).rejects.toThrow(/cannot be renamed/);
    await expect(updateAlias(index.id, { enabled: false })).rejects.toThrow(/cannot be disabled/);
  });

  test("the reserved alias's port always mirrors dashboardPort", async () => {
    const index = (await listAliases()).find((a) => a.reserved)!;
    expect((await updateAlias(index.id, { port: 1234 })).port).toBe(7788);
    expect((await updateAlias(index.id, { description: "hi" })).description).toBe("hi");
  });
});

describe("deleteAlias", () => {
  test("removes the alias", async () => {
    const alias = await createAlias({ name: "myapp", port: 3000 });
    await deleteAlias(alias.id);
    expect(await getAlias(alias.id)).toBeNull();
    expect(await listAliases()).toHaveLength(1);
  });

  test("refuses to delete the reserved alias", async () => {
    const index = (await listAliases()).find((a) => a.reserved)!;
    await expect(deleteAlias(index.id)).rejects.toThrow(/cannot be deleted/);
    expect(await getAlias(index.id)).not.toBeNull();
  });

  test("unknown id throws", async () => {
    await expect(deleteAlias("nope")).rejects.toThrow(ValidationError);
  });
});

describe("updateSettings", () => {
  test("updates tld, port and https, normalizing the tld", async () => {
    const config = await updateSettings({ tld: " TEST ", dashboardPort: 9999, https: true });
    expect(config.tld).toBe("test");
    expect(config.dashboardPort).toBe(9999);
    expect(config.https).toBe(true);
  });

  test("moves the reserved alias's port with dashboardPort", async () => {
    await updateSettings({ dashboardPort: 9100 });
    expect((await listAliases()).find((a) => a.reserved)!.port).toBe(9100);
  });

  test("rejects bad values and leaves the file alone", async () => {
    await loadConfig();
    const before = await raw();
    await expect(updateSettings({ tld: "not valid" })).rejects.toThrow(ValidationError);
    await expect(updateSettings({ dashboardPort: 0 })).rejects.toThrow(ValidationError);
    expect(await raw()).toEqual(before);
  });

  test("an empty patch changes nothing", async () => {
    const before = await loadConfig();
    const after = await updateSettings({});
    expect(after).toEqual(before);
  });
});

describe("atomic writes", () => {
  test("no temp files are left behind", async () => {
    await createAlias({ name: "myapp", port: 3000 });
    await updateSettings({ https: true });
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  test("the file is pretty-printed JSON with a trailing newline", async () => {
    await loadConfig();
    const text = await readFile(configPath(), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": 2');
  });
});
