import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeWorkspace, readWorkspace, workspacePath, writeWorkspace } from "../src/workspace.ts";
import { WORKSPACE_FILENAME } from "../src/types.ts";

async function project(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "la-ws-"));
  if (contents !== undefined) await writeFile(join(dir, WORKSPACE_FILENAME), contents);
  return dir;
}

describe("readWorkspace", () => {
  test("absent file is null, not an error", async () => {
    expect(await readWorkspace(await project())).toBeNull();
  });

  test("reads aliases and keeps $schema", async () => {
    const dir = await project(
      JSON.stringify({ $schema: "./schema.json", aliases: [{ name: "Web", port: 3000, description: "d" }] }),
    );
    expect(await readWorkspace(dir)).toEqual({
      $schema: "./schema.json",
      aliases: [{ name: "web", port: 3000, description: "d" }],
    });
  });

  test("omits description when absent", async () => {
    const dir = await project(JSON.stringify({ aliases: [{ name: "web", port: 3000 }] }));
    expect(await readWorkspace(dir)).toEqual({ aliases: [{ name: "web", port: 3000 }] });
  });

  test.each([
    ["broken JSON", "{nope"],
    ["not an object", "[]"],
    ["missing aliases", "{}"],
    ["aliases not an array", '{"aliases":{}}'],
    ["alias not an object", '{"aliases":["web"]}'],
    ["invalid name", '{"aliases":[{"name":"-bad","port":3000}]}'],
    ["invalid port", '{"aliases":[{"name":"web","port":0}]}'],
  ])("throws on %s", async (_label, contents) => {
    const dir = await project(contents);
    await expect(readWorkspace(dir)).rejects.toThrow();
  });

  test("the error names the file", async () => {
    const dir = await project("{nope");
    await expect(readWorkspace(dir)).rejects.toThrow(WORKSPACE_FILENAME);
  });
});

describe("writeWorkspace", () => {
  test("round-trips", async () => {
    const dir = await project();
    const file = { aliases: [{ name: "web", port: 3000 }] };
    const path = await writeWorkspace(dir, file);
    expect(path).toBe(workspacePath(dir));
    expect(await readWorkspace(dir)).toEqual(file);
  });

  test("writes pretty JSON with a trailing newline", async () => {
    const dir = await project();
    await writeWorkspace(dir, { aliases: [{ name: "web", port: 3000 }] });
    const text = await Bun.file(workspacePath(dir)).text();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "aliases"');
  });

  test("overwrites an existing file", async () => {
    const dir = await project(JSON.stringify({ aliases: [{ name: "old", port: 1000 }] }));
    await writeWorkspace(dir, { aliases: [{ name: "new", port: 2000 }] });
    expect((await readWorkspace(dir))!.aliases).toEqual([{ name: "new", port: 2000 }]);
  });
});

describe("mergeWorkspace", () => {
  test("starts from nothing", () => {
    expect(mergeWorkspace(null, [{ name: "web", port: 3000 }])).toEqual({
      aliases: [{ name: "web", port: 3000 }],
    });
  });

  test("incoming wins, order is preserved, new names are appended", () => {
    const existing = {
      aliases: [
        { name: "web", port: 3000 },
        { name: "api", port: 4000 },
      ],
    };
    expect(mergeWorkspace(existing, [{ name: "api", port: 4100 }, { name: "docs", port: 5000 }])).toEqual({
      aliases: [
        { name: "web", port: 3000 },
        { name: "api", port: 4100 },
        { name: "docs", port: 5000 },
      ],
    });
  });

  test("matches names case-insensitively and normalizes them", () => {
    const merged = mergeWorkspace({ aliases: [{ name: "web", port: 3000 }] }, [{ name: "WEB", port: 3001 }]);
    expect(merged.aliases).toEqual([{ name: "web", port: 3001 }]);
  });

  test("keeps an existing description when the incoming entry has none", () => {
    const merged = mergeWorkspace({ aliases: [{ name: "web", port: 3000, description: "keep" }] }, [
      { name: "web", port: 3001 },
    ]);
    expect(merged.aliases[0]).toEqual({ name: "web", port: 3001, description: "keep" });
  });

  test("preserves $schema and does not mutate the input", () => {
    const existing = { $schema: "s", aliases: [{ name: "web", port: 3000 }] };
    const merged = mergeWorkspace(existing, [{ name: "web", port: 9999 }]);
    expect(merged.$schema).toBe("s");
    expect(existing.aliases[0]!.port).toBe(3000);
  });

  test("merging nothing is a copy", () => {
    expect(mergeWorkspace({ aliases: [{ name: "web", port: 3000 }] }, [])).toEqual({
      aliases: [{ name: "web", port: 3000 }],
    });
  });
});
