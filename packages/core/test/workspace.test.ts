import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_FILENAME } from "../src/types.ts";
import {
  WORKSPACE_SCHEMA_URL,
  mergeWorkspaceAliases,
  readWorkspace,
  workspacePath,
  writeWorkspace,
} from "../src/workspace.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "la-workspace-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("workspacePath", () => {
  test("joins the fixed filename onto the project dir", () => {
    expect(workspacePath("/projects/app")).toBe(`/projects/app/${WORKSPACE_FILENAME}`);
  });
});

describe("readWorkspace", () => {
  test("returns null when the file is absent (the file is optional)", async () => {
    expect(await readWorkspace(tempDir())).toBeNull();
  });

  test("parses aliases", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), '{ "aliases": [{ "name": "api", "port": 3000 }] }');
    expect(await readWorkspace(dir)).toEqual({ aliases: [{ name: "api", port: 3000 }] });
  });

  test("preserves unknown top-level keys", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), '{ "team": "core", "aliases": [] }');
    const file = await readWorkspace(dir);
    expect((file as unknown as Record<string, unknown>).team).toBe("core");
  });

  test("defaults a missing aliases key to an empty list", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), '{ "note": "hi" }');
    expect((await readWorkspace(dir))?.aliases).toEqual([]);
  });

  test("throws a clear error on invalid JSON", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), "{ nope");
    expect(readWorkspace(dir)).rejects.toThrow(/is not valid JSON/);
  });

  test("throws when the file is empty", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), "");
    expect(readWorkspace(dir)).rejects.toThrow(/is not valid JSON/);
  });

  test("throws when the root is not an object", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), "[1, 2]");
    expect(readWorkspace(dir)).rejects.toThrow(/must contain a JSON object/);
  });

  test("throws when aliases is not an array", async () => {
    const dir = tempDir();
    await Bun.write(workspacePath(dir), '{ "aliases": { "api": 3000 } }');
    expect(readWorkspace(dir)).rejects.toThrow(/"aliases" must be an array/);
  });
});

describe("writeWorkspace", () => {
  test("pretty-prints with 2 spaces, a trailing newline and a $schema", async () => {
    const dir = tempDir();
    await writeWorkspace(dir, { aliases: [{ name: "api", port: 3000 }] });
    const text = await Bun.file(workspacePath(dir)).text();
    expect(text).toBe(
      `{\n` +
        `  "$schema": "${WORKSPACE_SCHEMA_URL}",\n` +
        `  "aliases": [\n` +
        `    {\n` +
        `      "name": "api",\n` +
        `      "port": 3000\n` +
        `    }\n` +
        `  ]\n` +
        `}\n`,
    );
  });

  test("keeps a $schema the user already set and any extra keys", async () => {
    const dir = tempDir();
    await writeWorkspace(dir, {
      $schema: "./custom.json",
      aliases: [],
      team: "core",
    } as never);
    const raw = JSON.parse(await Bun.file(workspacePath(dir)).text());
    expect(raw.$schema).toBe("./custom.json");
    expect(raw.team).toBe("core");
  });

  test("creates the project dir when missing and round-trips", async () => {
    const dir = join(tempDir(), "nested", "project");
    await writeWorkspace(dir, { aliases: [{ name: "web", port: 5173 }] });
    expect((await readWorkspace(dir))?.aliases).toEqual([{ name: "web", port: 5173 }]);
  });
});

describe("mergeWorkspaceAliases", () => {
  test("creates the file when absent", async () => {
    const dir = tempDir();
    const file = await mergeWorkspaceAliases(dir, [{ name: "api", port: 3000 }]);
    expect(file.aliases).toEqual([{ name: "api", port: 3000 }]);
    expect(await readWorkspace(dir)).toEqual(file);
  });

  test("last write wins on port and description", async () => {
    const dir = tempDir();
    await mergeWorkspaceAliases(dir, [{ name: "api", port: 3000, description: "old" }]);
    const file = await mergeWorkspaceAliases(dir, [{ name: "api", port: 4000, description: "new" }]);
    expect(file.aliases).toEqual([{ name: "api", port: 4000, description: "new" }]);
  });

  test("an omitted description does not wipe the existing one", async () => {
    const dir = tempDir();
    await mergeWorkspaceAliases(dir, [{ name: "api", port: 3000, description: "keep" }]);
    const file = await mergeWorkspaceAliases(dir, [{ name: "api", port: 4000 }]);
    expect(file.aliases).toEqual([{ name: "api", port: 4000, description: "keep" }]);
  });

  test("later duplicates within one call win", async () => {
    const dir = tempDir();
    const file = await mergeWorkspaceAliases(dir, [
      { name: "api", port: 1000 },
      { name: "api", port: 2000 },
    ]);
    expect(file.aliases).toEqual([{ name: "api", port: 2000 }]);
  });

  test("preserves unknown top-level keys and unknown entry keys", async () => {
    const dir = tempDir();
    await Bun.write(
      workspacePath(dir),
      JSON.stringify({
        $schema: "./custom.json",
        team: "core",
        aliases: [{ name: "api", port: 3000, owner: "kevin" }],
      }),
    );
    const file = await mergeWorkspaceAliases(dir, [{ name: "api", port: 3001 }]);
    const raw = JSON.parse(await Bun.file(workspacePath(dir)).text());
    expect(raw.team).toBe("core");
    expect(raw.$schema).toBe("./custom.json");
    expect(file.aliases).toEqual([{ name: "api", port: 3001, owner: "kevin" } as never]);
  });

  test("keeps a stable sort order regardless of insertion order", async () => {
    const dir = tempDir();
    await mergeWorkspaceAliases(dir, [
      { name: "web", port: 5173 },
      { name: "api", port: 3000 },
    ]);
    const file = await mergeWorkspaceAliases(dir, [{ name: "docs", port: 4000 }]);
    expect(file.aliases.map((a) => a.name)).toEqual(["api", "docs", "web"]);
  });

  test("is idempotent on disk", async () => {
    const dir = tempDir();
    await mergeWorkspaceAliases(dir, [{ name: "api", port: 3000 }]);
    const once = await Bun.file(workspacePath(dir)).text();
    await mergeWorkspaceAliases(dir, [{ name: "api", port: 3000 }]);
    expect(await Bun.file(workspacePath(dir)).text()).toBe(once);
  });

  test("leaves no temp files behind", async () => {
    const dir = tempDir();
    await mergeWorkspaceAliases(dir, [{ name: "api", port: 3000 }]);
    const entries = [...new Bun.Glob("*").scanSync({ cwd: dir, dot: true })];
    expect(entries).toEqual([WORKSPACE_FILENAME]);
  });
});
