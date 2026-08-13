/** Shared write helpers. Internal: not re-exported from index.ts. */
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write via a temp file in the same directory, then rename. Same directory matters:
 * rename is only atomic within one filesystem. An existing file's mode is preserved,
 * because we also rewrite files we do not own (~/.claude.json).
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    mode = undefined;
  }

  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, data, "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}

/** File contents, or null when the file does not exist. */
export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

/** Copy `path` to `path.bak-<timestamp>`; returns the backup path, or null if absent. */
export async function backupFile(path: string, suffix = "bak"): Promise<string | null> {
  const existing = await readFileOrNull(path);
  if (existing === null) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.${suffix}-${stamp}`;
  await writeFileAtomic(dest, existing);
  return dest;
}
