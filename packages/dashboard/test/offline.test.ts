/**
 * The /offline reading, and the desired-state hint the root agent renders its inline 503
 * from. Neither ever opens a socket here: the probe is injected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlias } from "@localhost-aliases/core";
import { normaliseHost, readOffline, type OfflineDeps } from "../lib/offline.ts";
import { clearStackCache } from "../lib/stack-hints.ts";
import { sandbox, stubProbes, type Sandbox } from "./helpers.ts";
import { sync, listProjects } from "../lib/service.ts";

let box: Sandbox;
let projects: string;

/** Nothing is listening anywhere, and the clock does not move. */
const down: OfflineDeps = { probe: async () => false, now: () => new Date("2026-01-02T03:04:05.000Z") };
const up: OfflineDeps = { ...down, probe: async () => true };

beforeEach(async () => {
  box = await sandbox();
  projects = await mkdtemp(join(tmpdir(), "la-offline-"));
  clearStackCache();
});
afterEach(async () => {
  await box.cleanup();
  await rm(projects, { recursive: true, force: true });
});

async function nextProject(name: string): Promise<string> {
  const path = join(projects, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ dependencies: { next: "15" }, scripts: { dev: "next dev" } }),
    "utf8",
  );
  return path;
}

describe("normaliseHost", () => {
  test("accepts what a browser actually puts in the query string", () => {
    expect(normaliseHost("myapp.test")).toBe("myapp.test");
    expect(normaliseHost("  MyApp.Test  ")).toBe("myapp.test");
    expect(normaliseHost("http://myapp.test/some/path?x=1")).toBe("myapp.test");
    expect(normaliseHost("myapp.test:80")).toBe("myapp.test");
    expect(normaliseHost("myapp.test.")).toBe("myapp.test");
    expect(normaliseHost("myapp.test?x=1")).toBe("myapp.test");
    expect(normaliseHost("myapp.test#frag")).toBe("myapp.test");
  });

  test("refuses anything that is not a hostname, rather than half-trusting it", () => {
    for (const bad of ["", null, undefined, "a b", "my app.test", "<script>", "a_b", "a%2e"]) {
      expect(normaliseHost(bad as string)).toBe("");
    }
  });
});

describe("readOffline", () => {
  test("names the alias, the port and the loopback address it is patched to", async () => {
    await createAlias({ name: "shop", port: 3000 });
    const view = await readOffline("shop.test", down);

    expect(view.known).toBe(true);
    expect(view.alias?.targetPort).toBe(3000);
    expect(view.alias?.url).toBe("http://shop.test");
    expect(view.alias?.ip).toBe("127.0.0.3"); // 127.0.0.2 is the reserved dashboard alias
    expect(view.listening).toBe(false);
  });

  test("carries the exact command for a folder it recognises", async () => {
    const path = await nextProject("shop");
    await createAlias({ name: "shop", port: 4321, projectPath: path });

    const view = await readOffline("shop.test", down);
    expect(view.stack).toEqual({
      framework: "Next.js",
      command: "next dev -p 4321",
      confidence: "high",
    });
  });

  test("an unrecognised folder is null, not a guess", async () => {
    const path = join(projects, "mystery");
    await mkdir(path, { recursive: true });
    await createAlias({ name: "mystery", port: 3000, projectPath: path });
    expect((await readOffline("mystery.test", down)).stack).toBeNull();
  });

  test("a folder that has been deleted still yields a usable page", async () => {
    const path = await nextProject("archived");
    await createAlias({ name: "archived", port: 3000, projectPath: path });
    await rm(path, { recursive: true, force: true });
    clearStackCache();

    const view = await readOffline("archived.test", down);
    expect(view.known).toBe(true);
    expect(view.alias?.targetPort).toBe(3000);
    expect(view.stack).toBeNull();
  });

  test("the reading flips the moment the port answers", async () => {
    await createAlias({ name: "shop", port: 3000 });
    expect((await readOffline("shop.test", down)).listening).toBe(false);
    expect((await readOffline("shop.test", up)).listening).toBe(true);
  });

  test("a hostname nothing is patched to is 'unknown', with no alias invented", async () => {
    const view = await readOffline("ghost.test", down);
    expect(view.known).toBe(false);
    expect(view.alias).toBeNull();
    expect(view.hostname).toBe("ghost.test");
  });

  test("no hostname at all is answered, not thrown", async () => {
    const view = await readOffline(null, down);
    expect(view.known).toBe(false);
    expect(view.hostname).toBe("");
  });

  test("the dashboard's own alias reports the dashboard port, not the stored one", async () => {
    const view = await readOffline("index.test", down);
    expect(view.alias?.reserved).toBe(true);
    expect(view.alias?.targetPort).toBe(7788);
  });
});

describe("the hint the root agent reads", () => {
  const bare = { probes: stubProbes(), probeStatuses: false as const };

  test("desired-state.json carries framework and command per route", async () => {
    const path = await nextProject("shop");
    await createAlias({ name: "shop", port: 3000, projectPath: path });

    const { desired } = await sync(bare);
    const shop = desired.routes.find((r) => r.hostname === "shop.test");
    expect(shop?.hint).toEqual({ framework: "Next.js", command: "next dev -p 3000" });

    // The reserved dashboard alias has no folder, so it carries no hint.
    const index = desired.routes.find((r) => r.hostname === "index.test");
    expect(index?.hint).toBeUndefined();
  });

  test("routes.json — the file the agent actually watches — carries it too", async () => {
    const path = await nextProject("shop");
    await createAlias({ name: "shop", port: 3000, projectPath: path });
    await sync(bare);

    const routes = JSON.parse(await Bun.file(join(box.configDir, "routes.json")).text()) as Array<{
      hostname: string;
      hint?: { framework: string; command: string };
    }>;
    expect(routes.find((r) => r.hostname === "shop.test")?.hint?.command).toBe("next dev -p 3000");
  });

  test("listProjects surfaces the same detection for the project card", async () => {
    const path = await nextProject("shop");
    await createAlias({ name: "shop", port: 3000, projectPath: path });

    const [project] = await listProjects(bare);
    expect(project?.stack?.framework).toBe("Next.js");
    expect(project?.stack?.command).toBe("next dev -p 3000");
  });

  test("a folder with several aliases is described against the lowest port, stably", async () => {
    const path = await nextProject("shop");
    await createAlias({ name: "api", port: 4000, projectPath: path });
    await createAlias({ name: "web", port: 3000, projectPath: path });

    const [project] = await listProjects(bare);
    expect(project?.stack?.command).toBe("next dev -p 3000");
  });
});
