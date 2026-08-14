/**
 * The two files the privileged script and the forwarder consume.
 *
 * They live here rather than in service.ts so the privileged channel and the auto-apply
 * scheduler can write them without importing the whole service layer — service.ts imports
 * the scheduler, and the scheduler's wiring imports the channel, so a channel that reached
 * back into service.ts would close an import cycle.
 */
import { desiredStatePath, routesPath, type DesiredState } from "@localhost-aliases/core";
import { writeJsonAtomic } from "./files.ts";

/**
 * Routes are written separately because the forwarder watches that file: a port-only
 * change is picked up without a prompt.
 */
export async function writeRuntimeFiles(desired: DesiredState): Promise<void> {
  await writeJsonAtomic(desiredStatePath(), desired);
  await writeJsonAtomic(routesPath(), desired.routes);
}
