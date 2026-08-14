/**
 * Renders the landing-page hero: an h264 mp4, a vp9 webm, a poster and a reduced-motion
 * still. Run with `bun run render:hero` from packages/assets.
 *
 * The @remotion/renderer API does not read remotion.config.ts (that file only configures
 * the CLI), so the browser lookup is repeated here on purpose.
 */
import { createServer } from "node:net";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { POSTER_FRAME } from "../src/hero/state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "out", "hero");

/** An mp4 above this is too heavy to autoplay on a landing page. */
const MP4_BUDGET_BYTES = 3 * 1024 * 1024;

/**
 * Remotion serves the bundle over HTTP and opens one page per worker. Under Bun that
 * server starts dropping connections past ~5 simultaneous page loads and the render dies
 * with "got no response", so the worker count is pinned rather than left to the CPU count.
 */
const CONCURRENCY = 4;

function findBrowser(): string | null {
  const candidates = [
    process.env.REMOTION_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Remotion serves the bundle over HTTP and defaults to port 3000 — which on a machine that
 * runs dev servers is exactly the port already taken. Every render gets its own fresh port:
 * reusing one across calls leaves the previous listener in TIME_WAIT and the next server
 * silently fails to bind.
 */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return fail(new Error("no port"));
      server.close(() => ok(address.port));
    });
  });
}

/**
 * Remotion's bundle server occasionally comes up unreachable under Bun and the render dies
 * on the first page load ("got no response"). It is not deterministic and a whole render is
 * a minute of work, so each step gets a couple of tries before giving up.
 */
async function attempt<T>(label: string, run: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (error) {
      if (i >= tries) throw error;
      console.log(`  ${label} failed (${(error as Error).message.split("\n")[0]}) — retrying`);
    }
  }
}

function report(label: string, file: string): number {
  const bytes = statSync(file).size;
  const size = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
  console.log(`  ${label.padEnd(11)} ${relative(ROOT, file).padEnd(28)} ${size}`);
  return bytes;
}

const bar = (label: string) => {
  let last = -1;
  return (progress: number) => {
    const pct = Math.round(progress * 100);
    if (pct === last || pct % 10 !== 0) return;
    last = pct;
    process.stdout.write(`  ${label} ${pct}%\r`);
  };
};

mkdirSync(OUT, { recursive: true });
const browserExecutable = findBrowser();

console.log("Bundling…");
const serveUrl = await bundle({ entryPoint: join(ROOT, "src", "index.ts") });
const composition = await attempt("select Hero", async () =>
  selectComposition({ serveUrl, id: "Hero", browserExecutable, port: await freePort() }));
const stillComposition = await attempt("select HeroStatic", async () =>
  selectComposition({ serveUrl, id: "HeroStatic", browserExecutable, port: await freePort() }));

const shared = {
  composition,
  serveUrl,
  browserExecutable,
  // PNG frames: the design is flat dark surfaces and hairlines, exactly what JPEG
  // intermediates smear. The encoder still decides the final quality.
  imageFormat: "png",
  // The hero is silent. Remotion adds a silent AAC track unless told twice not to, and a
  // video with no audio track at all is the one Safari will autoplay without argument.
  audioCodec: null,
  muted: true,
  enforceAudioTrack: false,
} as const;

console.log(`Rendering ${composition.durationInFrames} frames at ${composition.fps}fps…`);

const mp4 = join(OUT, "hero.mp4");
await attempt("mp4", async () =>
  renderMedia({
    ...shared,
    codec: "h264",
    concurrency: CONCURRENCY,
    // yuv420p is not the default for every codec path and Safari will refuse anything else.
    pixelFormat: "yuv420p",
    crf: 23,
    x264Preset: "slow",
    port: await freePort(),
    outputLocation: mp4,
    onProgress: ({ progress }) => bar("mp4 ")(progress),
  }),
);

const webm = join(OUT, "hero.webm");
await attempt("webm", async () =>
  renderMedia({
    ...shared,
    codec: "vp9",
    concurrency: CONCURRENCY,
    pixelFormat: "yuv420p",
    crf: 34,
    port: await freePort(),
    outputLocation: webm,
    onProgress: ({ progress }) => bar("webm")(progress),
  }),
);

/** The poster is what people see before the video plays, so it is the settled frame of the
 *  video itself — never frame 0, which is the empty "before" state. */
const poster = join(OUT, "hero-poster.png");
await attempt("poster", async () =>
  renderStill({ ...shared, frame: POSTER_FRAME, output: poster, port: await freePort() }));

/** The reduced-motion still is a different picture: it has no timeline to act out the swap,
 *  so `HeroStatic` states it instead. */
const still = join(OUT, "hero-static.png");
await attempt("still", async () =>
  renderStill({ ...shared, composition: stillComposition, output: still, port: await freePort() }));

console.log("\nWrote:");
const mp4Bytes = report("mp4", mp4);
report("webm", webm);
report("poster", poster);
report("still", still);

if (mp4Bytes > MP4_BUDGET_BYTES) {
  console.error(`\nhero.mp4 is ${(mp4Bytes / 1024 / 1024).toFixed(2)} MB, over the ${MP4_BUDGET_BYTES / 1024 / 1024} MB budget.`);
  process.exit(1);
}
