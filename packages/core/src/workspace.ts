/**
 * Project workspace file (`.localhost-aliases.json`) read/write.
 *
 * The file is entirely optional: a project without one is normal, not an error.
 * We only ever own the `aliases` key — every other key the user added is preserved.
 */
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKSPACE_FILENAME } from "./types.ts";
import type { WorkspaceAliasEntry, WorkspaceFile } from "./types.ts";

/** Advertised in the `$schema` key so editors can offer completion. */
export const WORKSPACE_SCHEMA_URL = "https://localhost-aliases.dev/schema/workspace-v1.json";

export function workspacePath(dir: string): string {
  return join(dir, WORKSPACE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns null when the file does not exist — that is the normal case. */
export async function readWorkspace(dir: string): Promise<WorkspaceFile | null> {
  const path = workspacePath(dir);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} is not valid JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  if (parsed.aliases !== undefined && !Array.isArray(parsed.aliases)) {
    throw new Error(`${path} is invalid: "aliases" must be an array.`);
  }
  return { ...parsed, aliases: (parsed.aliases ?? []) as WorkspaceAliasEntry[] } as WorkspaceFile;
}

/** Pretty-printed with 2 spaces and a trailing newline, so it diffs well in git. */
export async function writeWorkspace(dir: string, file: WorkspaceFile): Promise<void> {
  const path = workspacePath(dir);
  const { $schema, aliases, ...rest } = file;
  const body = { $schema: $schema ?? WORKSPACE_SCHEMA_URL, aliases: aliases ?? [], ...rest };

  await mkdir(dirname(path), { recursive: true });
  // Write + rename so a crash never leaves the user with a truncated project file.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, `${JSON.stringify(body, null, 2)}\n`);
  await rename(tmp, path);
}

function byName(a: WorkspaceAliasEntry, b: WorkspaceAliasEntry): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * Merges entries into the workspace file by alias name (last write wins) and
 * persists it. Unknown top-level keys and unknown per-entry keys survive; the
 * alias list is kept sorted by name so repeated merges produce stable diffs.
 * Fields left `undefined` by the caller do not clobber existing values.
 */
export async function mergeWorkspaceAliases(
  dir: string,
  entries: WorkspaceAliasEntry[],
): Promise<WorkspaceFile> {
  const existing = (await readWorkspace(dir)) ?? { aliases: [] };

  const merged = new Map<string, WorkspaceAliasEntry>();
  for (const entry of existing.aliases) merged.set(entry.name, entry);
  for (const entry of entries) {
    const previous = merged.get(entry.name);
    const patch = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
    merged.set(entry.name, { ...previous, ...patch } as WorkspaceAliasEntry);
  }

  const file: WorkspaceFile = {
    ...existing,
    // Mirrors exactly what writeWorkspace persists, so callers can trust the return value.
    $schema: existing.$schema ?? WORKSPACE_SCHEMA_URL,
    aliases: [...merged.values()].sort(byName),
  };
  await writeWorkspace(dir, file);
  return file;
}
