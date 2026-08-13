/**
 * The optional project-local .localhost-aliases.json. Its absence is normal and never
 * an error; malformed content is an error, because silently ignoring it would lose
 * aliases the user committed to their repo.
 */
import { join } from "node:path";
import { WORKSPACE_FILENAME, type WorkspaceAliasEntry, type WorkspaceFile } from "./types.ts";
import { isValidName, isValidPort, normalizeName } from "./validation.ts";
import { readFileOrNull, writeFileAtomic } from "./atomic.ts";

export function workspacePath(dir: string): string {
  return join(dir, WORKSPACE_FILENAME);
}

function parseWorkspace(text: string, path: string): WorkspaceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.aliases)) {
    throw new Error(`${path} must have an "aliases" array.`);
  }

  const aliases: WorkspaceAliasEntry[] = [];
  for (const entry of raw.aliases) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${path}: every alias must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? normalizeName(e.name) : "";
    if (!isValidName(name)) throw new Error(`${path}: "${String(e.name)}" is not a valid alias name.`);
    if (!isValidPort(e.port)) throw new Error(`${path}: "${name}" has an invalid port.`);
    aliases.push({
      name,
      port: e.port,
      ...(typeof e.description === "string" ? { description: e.description } : {}),
    });
  }

  return {
    ...(typeof raw.$schema === "string" ? { $schema: raw.$schema } : {}),
    aliases,
  };
}

/** null when the project has no workspace file. Throws when it has a broken one. */
export async function readWorkspace(dir: string): Promise<WorkspaceFile | null> {
  const path = workspacePath(dir);
  const text = await readFileOrNull(path);
  if (text === null) return null;
  return parseWorkspace(text, path);
}

export async function writeWorkspace(dir: string, file: WorkspaceFile): Promise<string> {
  const path = workspacePath(dir);
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

/** Incoming entries win; existing order is kept and new names are appended. */
export function mergeWorkspace(
  existing: WorkspaceFile | null,
  incoming: readonly WorkspaceAliasEntry[],
): WorkspaceFile {
  const merged: WorkspaceAliasEntry[] = existing ? existing.aliases.map((a) => ({ ...a })) : [];
  for (const entry of incoming) {
    const name = normalizeName(entry.name);
    const index = merged.findIndex((a) => normalizeName(a.name) === name);
    const next: WorkspaceAliasEntry = {
      name,
      port: entry.port,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    };
    if (index === -1) merged.push(next);
    else merged[index] = { ...merged[index], ...next };
  }
  return {
    ...(existing?.$schema !== undefined ? { $schema: existing.$schema } : {}),
    aliases: merged,
  };
}
