/**
 * Copies out/ into the consumers listed in docs/WEB.md.
 *
 * out/ is produced by three independent render scripts, so a run where only one of them
 * has happened is normal, not an error: a missing source is reported as `skipped` and the
 * run still succeeds. Copies are content-compared first, so re-running is a no-op and
 * nothing shows up in `git status` that did not actually change.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ASSETS = join(import.meta.dir, "..");
const OUT = join(ASSETS, "out");
const REPO = join(ASSETS, "..", "..");

/** [source under out/, destination relative to the repo root] — the table in docs/WEB.md. */
const ROUTES: [string, string][] = [
  ["icon/AppIcon.icns", "apps/tray/Resources/AppIcon.icns"],
  ["web/favicon.ico", "packages/site/public/favicon.ico"],
  ["web/icon-16.png", "packages/site/public/icon-16.png"],
  ["web/icon-32.png", "packages/site/public/icon-32.png"],
  ["web/icon-192.png", "packages/site/public/icon-192.png"],
  ["web/icon-512.png", "packages/site/public/icon-512.png"],
  ["web/apple-touch-icon.png", "packages/site/public/apple-touch-icon.png"],
  ["web/maskable-512.png", "packages/site/public/maskable-512.png"],
  ["web/site.webmanifest", "packages/site/public/site.webmanifest"],
  ["og/og.png", "packages/site/public/og.png"],
  ["hero/hero.mp4", "packages/site/public/hero.mp4"],
  ["hero/hero.webm", "packages/site/public/hero.webm"],
  ["hero/hero-poster.png", "packages/site/public/hero-poster.png"],
  // WEB.md's frozen path table omits this one, but the same document's "Consequences"
  // section lists "hero video + poster + static fallback" among the committed assets, and
  // hero-assets.ts already looks for it by this name. Without the route the site falls
  // back to the poster under prefers-reduced-motion — a settled frame that never shows
  // what was replaced, which is the one thing the static was drawn to say.
  ["hero/hero-static.png", "packages/site/public/hero-static.png"],
];

// out/icon/icon-1024.png is deliberately absent: it is a reference render for store
// listings, with no consumer in the repo.

type Result = "copied" | "unchanged" | "skipped";

async function sameBytes(a: Uint8Array, path: string): Promise<boolean> {
  const dest = Bun.file(path);
  if (!(await dest.exists())) return false;
  const b = new Uint8Array(await dest.arrayBuffer());
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function syncOne(from: string, to: string): Promise<Result> {
  const source = Bun.file(join(OUT, from));
  if (!(await source.exists())) return "skipped";

  const bytes = new Uint8Array(await source.arrayBuffer());
  const target = join(REPO, to);
  if (await sameBytes(bytes, target)) return "unchanged";

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return "copied";
}

async function main() {
  const results = new Map<Result, string[]>([
    ["copied", []],
    ["unchanged", []],
    ["skipped", []],
  ]);

  for (const [from, to] of ROUTES) {
    const result = await syncOne(from, to);
    results.get(result)!.push(result === "skipped" ? `out/${from}` : to);
    console.log(`${result.padEnd(9)} ${to}`);
  }

  const skipped = results.get("skipped")!;
  console.log(
    `\n${results.get("copied")!.length} copied, ${results.get("unchanged")!.length} unchanged, ` +
      `${skipped.length} skipped`,
  );
  if (skipped.length > 0) {
    console.log(`not rendered yet: ${skipped.join(", ")}`);
  }
}

await main();
