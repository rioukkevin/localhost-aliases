/**
 * Renders the web icon set + the OG card, then assembles favicon.ico and site.webmanifest.
 *
 * Uses the programmatic renderer rather than eight `remotion still` shell-outs so the
 * bundle is built once. That means remotion.config.ts (CLI-only) does not apply, so the
 * browser lookup it does is repeated here — same candidate list, same REMOTION_BROWSER
 * override.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { brand, productName, tagline } from "../src/brand.ts";
import { buildIco, readPngSize } from "./ico.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "out");

/** id -> path under out/. icon-48 is an .ico input only; nothing else consumes it. */
const STILLS = [
  { id: "WebIcon16", out: "web/icon-16.png" },
  { id: "WebIcon32", out: "web/icon-32.png" },
  { id: "WebIcon48", out: "web/icon-48.png" },
  { id: "WebIcon180", out: "web/apple-touch-icon.png" },
  { id: "WebIcon192", out: "web/icon-192.png" },
  { id: "WebIcon512", out: "web/icon-512.png" },
  { id: "WebMaskable512", out: "web/maskable-512.png" },
  { id: "OgCard", out: "og/og.png" },
] as const;

const ICO_INPUTS = ["web/icon-16.png", "web/icon-32.png", "web/icon-48.png"];

function findBrowser(): string | null {
  const candidates = [
    process.env.REMOTION_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function manifest() {
  return {
    name: productName,
    short_name: "Aliases",
    description: tagline,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: brand.canvas,
    theme_color: brand.canvas,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate entry, not `purpose: "any maskable"`: the maskable art is inset for the
      // launcher's circular crop and would look lost if a browser also used it as-is.
      { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

async function write(rel: string, data: Uint8Array | string) {
  const path = join(OUT, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}

async function main() {
  const browserExecutable = findBrowser();
  console.log(browserExecutable ? `browser: ${browserExecutable}` : "browser: remotion default");

  let lastLogged = -1;
  const serveUrl = await bundle({
    entryPoint: join(ROOT, "src/index.ts"),
    onProgress: (p) => {
      const step = Math.floor(p / 25);
      if (step !== lastLogged) {
        lastLogged = step;
        console.log(`bundling ${p}%`);
      }
    },
  });

  for (const still of STILLS) {
    const output = join(OUT, still.out);
    await mkdir(dirname(output), { recursive: true });
    const composition = await selectComposition({ serveUrl, id: still.id, browserExecutable });
    await renderStill({
      composition,
      serveUrl,
      output,
      browserExecutable,
      imageFormat: "png",
      overwrite: true,
    });
    console.log(`rendered ${still.out} (${composition.width}x${composition.height})`);
  }

  const images = await Promise.all(
    ICO_INPUTS.map(async (rel) => {
      const png = new Uint8Array(await Bun.file(join(OUT, rel)).arrayBuffer());
      return { ...readPngSize(png), png };
    }),
  );
  const ico = buildIco(images);
  await write("web/favicon.ico", ico);
  console.log(
    `wrote web/favicon.ico (${ico.length} bytes, ${images.map((i) => i.width).join("/")})`,
  );

  await write("web/site.webmanifest", `${JSON.stringify(manifest(), null, 2)}\n`);
  console.log("wrote web/site.webmanifest");
}

await main();
