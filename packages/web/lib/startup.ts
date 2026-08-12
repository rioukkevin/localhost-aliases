/**
 * What `instrumentation.ts` runs once per server start, kept in its own module so
 * the instrumentation entry stays a single prunable dynamic import (see the note
 * there — anything Node-only reachable from the edge compilation breaks the build).
 *
 * It must never take the dashboard down with it: an absent helper is the normal
 * first-run state, so every failure is swallowed and logged.
 */
import { loadConfig } from "@localhost-aliases/core";
import { pushDesiredState } from "./desired-state.ts";

export async function startupApply(): Promise<void> {
  try {
    const warning = await pushDesiredState(await loadConfig());
    if (warning === null) console.log("[api] desired state pushed to the helper on startup");
    else console.log(`[api] startup apply skipped: ${warning}`);
  } catch (error) {
    console.error("[api] startup apply failed:", error);
  }
}
