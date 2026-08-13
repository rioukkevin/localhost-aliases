/**
 * The status file is how the unprivileged UI sees what a root process is doing.
 * Written atomically so a reader never sees half a file.
 */
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ForwarderStatus } from "@localhost-aliases/core/types";

export async function writeStatus(path: string, status: ForwarderStatus): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Removed on a clean exit so the UI reports "not running" rather than a stale pid. */
export async function clearStatus(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}
