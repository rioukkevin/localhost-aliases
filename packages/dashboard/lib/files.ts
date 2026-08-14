/**
 * Small filesystem helpers for the files the dashboard owns (desired-state.json,
 * routes.json, onboarding.json). node:fs is used rather than Bun.file so this module
 * also works during `next build`, which runs under node.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  const text = await readTextOrNull(path);
  if (text === null || text.trim() === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Temp file + rename, so a reader never sees a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Same collision as core/atomic.ts: a millisecond is not a unique suffix under polling.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
