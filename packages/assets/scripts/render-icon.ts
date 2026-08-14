#!/usr/bin/env bun
/**
 * Renders the macOS app icon.
 *
 *   bun run render:icon
 *
 * Every bitmap macOS asks for is rendered natively from its own Remotion composition —
 * not resized from the 1024 — because the 16/32px tiles carry simplified artwork. They are
 * then laid out as a `.iconset` under Apple's exact filenames and handed to `iconutil`.
 *
 * Outputs (frozen — see docs/WEB.md):
 *   out/icon/AppIcon.icns   -> apps/tray/Resources/AppIcon.icns (committed)
 *   out/icon/icon-1024.png  -> reference / store listing
 *
 * The intermediate .iconset is deleted on success and deliberately left behind on failure,
 * so a rejected set can be inspected. out/icon/bitmaps/ keeps the per-size renders, which
 * is the only place the 16px artwork can be looked at on its own. All of out/ is ignored
 * by git; the committed copy is apps/tray/Resources/AppIcon.icns.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICONSET_ENTRIES, ICON_PIXEL_SIZES, compositionId } from "../src/icon/sizes.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "out", "icon");
const ICONSET = join(OUT, "AppIcon.iconset");
const ICNS = join(OUT, "AppIcon.icns");
const BITMAPS = join(OUT, "bitmaps");

function die(message: string): never {
  console.error(`\n  render-icon: ${message}\n`);
  process.exit(1);
}

function run(cmd: string[], cwd: string) {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: proc.exitCode === 0,
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
  };
}

/**
 * A PNG that is not 8-bit RGBA has no alpha channel, which would fill the icon's margin
 * with black instead of leaving it transparent — the single most common way a hand-built
 * icns comes out looking like a black square. Cheap to check from the IHDR, so check it.
 */
function assertBitmap(file: string, px: number) {
  const buf = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) die(`${file} is not a PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colourType = buf[25];
  if (width !== px || height !== px) die(`${file} is ${width}x${height}, expected ${px}x${px}`);
  if (depth !== 8 || colourType !== 6) {
    die(`${file} is bit depth ${depth} colour type ${colourType}, expected 8-bit RGBA (6)`);
  }
}

// --- render ------------------------------------------------------------------
rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });
mkdirSync(BITMAPS, { recursive: true });

for (const px of ICON_PIXEL_SIZES) {
  const file = join(BITMAPS, `icon-${px}.png`);
  const id = compositionId(px);
  process.stdout.write(`  ${id.padEnd(12)} `);
  const result = run(["bunx", "remotion", "still", "src/index.ts", id, file, "--log=error"], PKG);
  if (!result.ok || !existsSync(file)) {
    console.error(`\n${result.out}`);
    die(`remotion still ${id} exited ${result.code}`);
  }
  assertBitmap(file, px);
  console.log(`${px}x${px}`);
}

// --- assemble the .iconset ---------------------------------------------------
for (const entry of ICONSET_ENTRIES) {
  copyFileSync(join(BITMAPS, `icon-${entry.px}.png`), join(ICONSET, entry.file));
}
console.log(`  iconset      ${ICONSET_ENTRIES.length} files`);

// --- iconutil ----------------------------------------------------------------
const iconutil = run(["iconutil", "--convert", "icns", "--output", ICNS, ICONSET], PKG);
if (iconutil.out) console.log(iconutil.out);
if (!iconutil.ok) die(`iconutil rejected the iconset (exit ${iconutil.code})`);
if (!existsSync(ICNS)) die("iconutil reported success but wrote no AppIcon.icns");

/**
 * iconutil does NOT reject a wrong filename — verified: rename icon_32x32@2x.png to
 * icon_64x64.png and it still exits 0, having silently dropped that size from the icns.
 * So the real check is the round trip: unpack the icns again and insist every expected
 * name came back.
 */
const verifyDir = join(OUT, ".verify.iconset");
rmSync(verifyDir, { recursive: true, force: true });
const back = run(["iconutil", "--convert", "iconset", "--output", verifyDir, ICNS], PKG);
if (!back.ok) {
  console.error(back.out);
  die("the generated AppIcon.icns does not read back as an iconset");
}
const packed = new Set(readdirSync(verifyDir));
const missing = ICONSET_ENTRIES.filter((e) => !packed.has(e.file)).map((e) => e.file);
rmSync(verifyDir, { recursive: true, force: true });
if (missing.length > 0) die(`iconutil dropped ${missing.length} size(s): ${missing.join(", ")}`);

copyFileSync(join(BITMAPS, "icon-1024.png"), join(OUT, "icon-1024.png"));
rmSync(ICONSET, { recursive: true, force: true });

console.log(`  AppIcon.icns ${(statSync(ICNS).size / 1024).toFixed(0)} KB`);
console.log(`  icon-1024.png`);
console.log(`\n  Copy out/icon/AppIcon.icns to apps/tray/Resources/AppIcon.icns to ship it.`);
