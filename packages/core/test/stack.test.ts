import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_STACK_PORT, detectStack } from "../src/stack.ts";

/** A throwaway project folder. `files` maps relative paths to contents. */
async function project(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "la-stack-"));
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  }
  return dir;
}

const PORT = 4321;

describe("detectStack — JavaScript frameworks", () => {
  test("Next.js from its dev script", async () => {
    const dir = await project({
      "package.json": { dependencies: { next: "15.0.0", react: "19" }, scripts: { dev: "next dev" } },
      "package-lock.json": "{}",
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Next.js",
      command: `next dev -p ${PORT}`,
      confidence: "high",
    });
  });

  test("Vite", async () => {
    const dir = await project({
      "package.json": { devDependencies: { vite: "6" }, scripts: { dev: "vite" } },
    });
    const found = await detectStack(dir, PORT);
    expect(found).toEqual({ framework: "Vite", command: `vite --port ${PORT}`, confidence: "high" });
  });

  test("Astro", async () => {
    const dir = await project({
      "package.json": { dependencies: { astro: "5", vite: "6" }, scripts: { dev: "astro dev" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Astro",
      command: `astro dev --port ${PORT}`,
      confidence: "high",
    });
  });

  test("Remix on vite", async () => {
    const dir = await project({
      "package.json": {
        dependencies: { "@remix-run/react": "2" },
        devDependencies: { "@remix-run/dev": "2", vite: "5" },
        scripts: { dev: "remix vite:dev" },
      },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Remix",
      command: `remix vite:dev --port ${PORT}`,
      confidence: "high",
    });
  });

  test("Remix classic compiler", async () => {
    const dir = await project({
      "package.json": { devDependencies: { "@remix-run/dev": "1" }, scripts: { dev: "remix dev" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Remix",
      command: `remix dev --port ${PORT}`,
      confidence: "high",
    });
  });

  test("Nuxt", async () => {
    const dir = await project({
      "package.json": { devDependencies: { nuxt: "3" }, scripts: { dev: "nuxt dev" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Nuxt",
      command: `nuxt dev --port ${PORT}`,
      confidence: "high",
    });
  });

  test("SvelteKit wins over Vite even though its dev script is plain `vite dev`", async () => {
    const dir = await project({
      "package.json": {
        devDependencies: { "@sveltejs/kit": "2", vite: "5" },
        scripts: { dev: "vite dev" },
      },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "SvelteKit",
      command: `vite dev --port ${PORT}`,
      confidence: "high",
    });
  });

  test("Create React App pins the port through PORT=", async () => {
    const dir = await project({
      "package.json": { dependencies: { "react-scripts": "5" }, scripts: { start: "react-scripts start" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Create React App",
      command: `PORT=${PORT} react-scripts start`,
      confidence: "high",
    });
  });

  test("Gatsby", async () => {
    const dir = await project({
      "package.json": { dependencies: { gatsby: "5" }, scripts: { develop: "gatsby develop" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Gatsby",
      command: `gatsby develop -p ${PORT}`,
      confidence: "high",
    });
  });

  test("a node static server, with the runner the lockfile implies", async () => {
    const dir = await project({
      "package.json": { devDependencies: { serve: "14" }, scripts: { start: "serve public" } },
      "bun.lock": "",
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Static server",
      command: `bunx serve -l ${PORT}`,
      confidence: "high",
    });
  });

  test("http-server gets its own flag", async () => {
    const dir = await project({
      "package.json": { devDependencies: { "http-server": "14" }, scripts: { start: "http-server ." } },
      "pnpm-lock.yaml": "",
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Static server",
      command: `pnpm dlx http-server -p ${PORT}`,
      confidence: "high",
    });
  });
});

describe("detectStack — non-JavaScript stacks", () => {
  test("Rails from the Gemfile", async () => {
    const dir = await project({ Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n' });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Rails",
      command: `rails s -p ${PORT}`,
      confidence: "high",
    });
  });

  test("Rails wins even when the app also has a package.json for its assets", async () => {
    const dir = await project({
      "bin/rails": "#!/usr/bin/env ruby\n",
      "package.json": { dependencies: { esbuild: "0.20.0" }, scripts: { build: "esbuild app.js" } },
    });
    expect((await detectStack(dir, PORT))?.framework).toBe("Rails");
  });

  test("Django", async () => {
    const dir = await project({ "manage.py": "import django\n" });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Django",
      command: `python manage.py runserver ${PORT}`,
      confidence: "high",
    });
  });

  test("a manage.py that never mentions Django is low confidence", async () => {
    const dir = await project({ "manage.py": "print('hi')\n" });
    expect((await detectStack(dir, PORT))?.confidence).toBe("low");
  });

  test("Laravel", async () => {
    const dir = await project({
      artisan: "#!/usr/bin/env php\n",
      "composer.json": { require: { "laravel/framework": "^11.0" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Laravel",
      command: `php artisan serve --port=${PORT}`,
      confidence: "high",
    });
  });

  test("a plain folder of files falls back to python3's http.server", async () => {
    const dir = await project({ "index.html": "<h1>hi</h1>", "style.css": "" });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Static site",
      command: `python3 -m http.server ${PORT}`,
      confidence: "low",
    });
  });
});

describe("detectStack — real-world shapes", () => {
  test("the dev script beats a framework that merely sits in the dependency list", async () => {
    const dir = await project({
      "package.json": {
        dependencies: { next: "15" },
        devDependencies: { vite: "6", vitest: "2" },
        scripts: { dev: "next dev", test: "vitest", storybook: "vite build" },
      },
    });
    expect((await detectStack(dir, PORT))?.framework).toBe("Next.js");
  });

  test("a monorepo root delegates, and the command says where to run it", async () => {
    const dir = await project({
      "package.json": {
        private: true,
        workspaces: ["packages/*"],
        devDependencies: { turbo: "2" },
        scripts: { dev: "turbo run dev" },
      },
      "packages/core/package.json": { name: "core" },
      "packages/web/package.json": { dependencies: { next: "15" }, scripts: { dev: "next dev" } },
      "bun.lock": "",
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Next.js",
      command: `cd packages/web && next dev -p ${PORT}`,
      confidence: "low",
    });
  });

  test("a root whose script names the child directory outright", async () => {
    const dir = await project({
      "package.json": { scripts: { dev: "bun run --cwd apps/dashboard dev" } },
      "apps/dashboard/package.json": { devDependencies: { vite: "6" }, scripts: { dev: "vite" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Vite",
      command: `cd apps/dashboard && vite --port ${PORT}`,
      confidence: "low",
    });
  });

  test("a script pointing outside the folder is never followed", async () => {
    const dir = await project({
      "package.json": { scripts: { dev: "bun run --cwd ../../elsewhere dev" } },
    });
    expect(await detectStack(dir, PORT)).toBeNull();
  });

  test("two frameworks and no script to arbitrate is low confidence", async () => {
    const dir = await project({
      "package.json": { dependencies: { next: "15", vite: "6" } },
    });
    expect(await detectStack(dir, PORT)).toEqual({
      framework: "Next.js",
      command: `next dev -p ${PORT}`,
      confidence: "low",
    });
  });

  test("one framework and no script at all is still high confidence", async () => {
    const dir = await project({ "package.json": { dependencies: { next: "15" } } });
    expect((await detectStack(dir, PORT))?.confidence).toBe("high");
  });
});

describe("detectStack — refusing to guess", () => {
  test("an empty folder", async () => {
    expect(await detectStack(await project({}), PORT)).toBeNull();
  });

  test("a folder that does not exist", async () => {
    expect(await detectStack(join(tmpdir(), `la-stack-missing-${Date.now()}`), PORT)).toBeNull();
  });

  test("an empty path", async () => {
    expect(await detectStack("", PORT)).toBeNull();
  });

  test("a package.json with no framework in it", async () => {
    const dir = await project({
      "package.json": { name: "lib", devDependencies: { typescript: "5" }, scripts: { build: "tsc" } },
    });
    expect(await detectStack(dir, PORT)).toBeNull();
  });

  test.each([
    ["malformed JSON", "{ not json"],
    ["an array", "[]"],
    ["a bare string", '"hello"'],
    ["an empty file", ""],
    ["scripts that are not strings", '{"scripts":{"dev":{"run":"next dev"}}}'],
    ["dependencies that are not an object", '{"dependencies":["next"]}'],
  ])("a package.json that is %s returns null instead of throwing", async (_label, contents) => {
    const dir = await project({ "package.json": contents });
    expect(await detectStack(dir, PORT)).toBeNull();
  });

  test("a malformed package.json still lets the Rails markers speak", async () => {
    const dir = await project({ "package.json": "{ not json", "bin/rails": "#!/usr/bin/env ruby\n" });
    expect((await detectStack(dir, PORT))?.framework).toBe("Rails");
  });

  test("a lockfile on its own is not a framework", async () => {
    expect(await detectStack(await project({ "bun.lock": "" }), PORT)).toBeNull();
  });
});

describe("detectStack — the port is always concrete", () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["Next.js", { "package.json": { dependencies: { next: "15" }, scripts: { dev: "next dev" } } }],
    ["Vite", { "package.json": { devDependencies: { vite: "6" }, scripts: { dev: "vite" } } }],
    ["Astro", { "package.json": { dependencies: { astro: "5" }, scripts: { dev: "astro dev" } } }],
    ["Remix", { "package.json": { devDependencies: { "@remix-run/dev": "2" }, scripts: { dev: "remix dev" } } }],
    ["Nuxt", { "package.json": { devDependencies: { nuxt: "3" }, scripts: { dev: "nuxt dev" } } }],
    ["SvelteKit", { "package.json": { devDependencies: { "@sveltejs/kit": "2" }, scripts: { dev: "vite dev" } } }],
    ["CRA", { "package.json": { dependencies: { "react-scripts": "5" }, scripts: { start: "react-scripts start" } } }],
    ["Gatsby", { "package.json": { dependencies: { gatsby: "5" }, scripts: { develop: "gatsby develop" } } }],
    ["static server", { "package.json": { devDependencies: { serve: "14" }, scripts: { start: "serve ." } } }],
    ["Rails", { Gemfile: 'gem "rails"\n' }],
    ["Django", { "manage.py": "import django\n" }],
    ["Laravel", { artisan: "#!/usr/bin/env php\n" }],
    ["static site", { "index.html": "<h1>hi</h1>" }],
  ];

  test.each(shapes)("%s pins the requested port", async (_label, files) => {
    const dir = await project(files);
    const found = await detectStack(dir, 8123);
    expect(found).not.toBeNull();
    expect(found?.command).toContain("8123");
  });

  test.each(shapes)("%s pins the default port when none is given", async (_label, files) => {
    const dir = await project(files);
    const found = await detectStack(dir);
    expect(found?.command).toContain(String(DEFAULT_STACK_PORT));
  });

  test("a nonsense port falls back to the default rather than emitting garbage", async () => {
    const dir = await project({ "package.json": { dependencies: { next: "15" } } });
    for (const bad of [0, -1, 70000, 1.5, Number.NaN]) {
      expect((await detectStack(dir, bad))?.command).toBe(`next dev -p ${DEFAULT_STACK_PORT}`);
    }
  });
});

describe("detectStack — read only", () => {
  test("it writes nothing into the project it inspects", async () => {
    const files = {
      "package.json": { dependencies: { next: "15" }, scripts: { dev: "next dev" } },
      "packages/web/package.json": { dependencies: { vite: "6" } },
      "index.html": "<h1>hi</h1>",
    };
    const dir = await project(files);
    const before = await Bun.$`find ${dir} -type f`.text();
    await detectStack(dir, PORT);
    expect(await Bun.$`find ${dir} -type f`.text()).toBe(before);
  });
});
