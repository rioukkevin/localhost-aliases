#!/usr/bin/env bun
/**
 * The whole asset pipeline, in the order docs/WEB.md documents it:
 *
 *   bun run --cwd packages/assets render:all      # renders icon, web + og, hero
 *   bun run packages/assets/scripts/sync.ts       # copies out/ into its consumers
 *
 * This script does both, so the documented one-liner is a single command. Each render is a
 * separate process on purpose: they are independent, they each build their own Remotion
 * bundle, and one failing must not leave a half-imported module graph behind. The first
 * failure stops the run — a partially re-rendered `out/` synced into the repo would commit an
 * icon set from one revision of the brand and a hero from another.
 *
 * Nothing here runs in CI. packages/assets is local-only (docs/WEB.md): rendering needs a real
 * Chrome, and the outputs are committed artwork that changes only when a human decides it did.
 */
import { join } from "node:path";

const SCRIPTS = import.meta.dir;

/** [label, script] — rendered in this order; sync runs last so it sees a complete out/. */
const STEPS: [string, string][] = [
  ["icon", "render-icon.ts"],
  ["web + og", "render-web.ts"],
  ["hero", "render-hero.ts"],
  ["sync", "sync.ts"],
];

async function run(label: string, script: string): Promise<void> {
  console.log(`\n==> ${label}  (${script})`);
  const child = Bun.spawn(["bun", "run", join(SCRIPTS, script)], {
    cwd: join(SCRIPTS, ".."),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${script} exited ${code} — stopping before anything else is re-rendered`);
  }
}

for (const [label, script] of STEPS) {
  await run(label, script);
}

console.log(
  "\nAll assets rendered and synced. `git status` now shows every consumer that changed;\n" +
    "commit them — CI never renders anything (docs/WEB.md).",
);
