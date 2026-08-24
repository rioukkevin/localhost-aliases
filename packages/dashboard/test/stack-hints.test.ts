/**
 * Route.hint, and the cache that keeps it from costing a disk read every five seconds.
 *
 * Everything here runs against real folders under mkdtemp — detection reads the disk, so
 * a stubbed filesystem would prove nothing about the thing being tested. Nothing outside
 * the temp directory is opened and nothing at all is written into it after setup.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesiredState, type Config } from "@localhost-aliases/core";
import {
  HINT_TTL_MS,
  attachHints,
  clearStackCache,
  detectStackCached,
  stackCacheSize,
  toHint,
} from "../lib/stack-hints.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "la-hints-"));
  clearStackCache();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function project(name: string, pkg: unknown): Promise<string> {
  const path = join(dir, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify(pkg), "utf8");
  return path;
}

function configWith(aliases: Array<{ name: string; port: number; projectPath: string | null }>): Config {
  const now = new Date().toISOString();
  return {
    version: 2,
    tld: "test",
    dashboardPort: 7788,
    https: false,
    autoApply: true,
    aliases: aliases.map((a, i) => ({
      id: `id-${a.name}`,
      name: a.name,
      port: a.port,
      ip: `127.0.0.${i + 2}`,
      projectPath: a.projectPath,
      description: null,
      enabled: true,
      reserved: false,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

describe("detectStackCached", () => {
  test("finds the framework and pins the alias's own port", async () => {
    const path = await project("web", { dependencies: { next: "15" }, scripts: { dev: "next dev" } });
    const stack = await detectStackCached(path, 4321);
    expect(stack?.framework).toBe("Next.js");
    expect(stack?.command).toContain("4321");
  });

  test("a second read of the same folder and port never touches the disk again", async () => {
    const path = await project("web", { dependencies: { next: "15" } });
    const first = await detectStackCached(path, 3000);
    expect(stackCacheSize()).toBe(1);

    // Break the folder underneath the cache. A cached answer must survive it, which is
    // the only observable proof that nothing was re-read.
    await rm(join(path, "package.json"));
    expect(await detectStackCached(path, 3000)).toEqual(first!);
    expect(stackCacheSize()).toBe(1);
  });

  test("a different port is a different question, and is asked again", async () => {
    const path = await project("web", { dependencies: { vite: "5" } });
    expect((await detectStackCached(path, 3000))?.command).toContain("3000");
    expect((await detectStackCached(path, 5173))?.command).toContain("5173");
    expect(stackCacheSize()).toBe(2);
  });

  test("the entry ages out, so adding a framework shows up without a restart", async () => {
    const path = join(dir, "later");
    await mkdir(path, { recursive: true });
    const t0 = 1_000_000;
    expect(await detectStackCached(path, 3000, t0)).toBeNull();

    await writeFile(join(path, "package.json"), JSON.stringify({ dependencies: { astro: "4" } }), "utf8");
    // Still inside the window: the cached "we do not know" stands.
    expect(await detectStackCached(path, 3000, t0 + HINT_TTL_MS - 1)).toBeNull();
    expect((await detectStackCached(path, 3000, t0 + HINT_TTL_MS))?.framework).toBe("Astro");
  });

  test("a folder that has been deleted or moved is null, never a throw", async () => {
    const path = await project("gone", { dependencies: { next: "15" } });
    await rm(path, { recursive: true, force: true });
    clearStackCache();
    expect(await detectStackCached(path, 3000)).toBeNull();
    expect(await detectStackCached(join(dir, "never-existed"), 3000)).toBeNull();
    expect(await detectStackCached("", 3000)).toBeNull();
  });
});

describe("attachHints", () => {
  test("puts framework and command on the routes whose alias has a folder", async () => {
    const path = await project("shop", { dependencies: { next: "15" }, scripts: { dev: "next dev" } });
    const config = configWith([
      { name: "shop", port: 3000, projectPath: path },
      { name: "loose", port: 4000, projectPath: null },
    ]);

    const desired = await attachHints(config, buildDesiredState(config));
    const shop = desired.routes.find((r) => r.hostname === "shop.test");
    const loose = desired.routes.find((r) => r.hostname === "loose.test");

    expect(shop?.hint).toEqual({ framework: "Next.js", command: "next dev -p 3000" });
    // No folder means no hint at all — not an empty one, which would read as a claim.
    expect(loose?.hint).toBeUndefined();
    expect(Object.keys(loose!)).not.toContain("hint");
  });

  test("an unrecognised folder leaves the route exactly as core built it", async () => {
    const path = join(dir, "plain");
    await mkdir(path, { recursive: true });
    const config = configWith([{ name: "plain", port: 3000, projectPath: path }]);
    const built = buildDesiredState(config);
    expect(await attachHints(config, built)).toEqual(built);
  });

  test("a config with no linked folders is returned untouched, without a single read", async () => {
    const config = configWith([{ name: "loose", port: 4000, projectPath: null }]);
    const built = buildDesiredState(config);
    expect(await attachHints(config, built)).toBe(built);
    expect(stackCacheSize()).toBe(0);
  });

  test("a deleted folder costs its hint, never the desired state", async () => {
    const path = await project("archived", { dependencies: { next: "15" } });
    const config = configWith([{ name: "archived", port: 3000, projectPath: path }]);
    await rm(path, { recursive: true, force: true });
    clearStackCache();

    const desired = await attachHints(config, buildDesiredState(config));
    expect(desired.routes).toHaveLength(1);
    expect(desired.routes[0]!.hostname).toBe("archived.test");
    expect(desired.routes[0]!.targetPort).toBe(3000);
    expect(desired.routes[0]!.hint).toBeUndefined();
  });
});

describe("toHint", () => {
  test("carries only the two advisory fields, never the confidence", () => {
    expect(toHint({ framework: "Vite", command: "vite --port 5173", confidence: "low" })).toEqual({
      framework: "Vite",
      command: "vite --port 5173",
    });
    expect(toHint(null)).toBeUndefined();
  });
});
