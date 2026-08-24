/**
 * The real entrypoint, run the way the tray runs it — only unprivileged: 127.0.0.1 and a
 * listen port above 1024, taken from the routes file rather than hardcoded to 80.
 */
import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, freePort, httpGet, route, tempDir, waitFor, writeRoutes } from "./helpers.ts";

const entry = join(import.meta.dir, "..", "src", "index.ts");
const bun = Bun.which("bun") ?? "bun";

let child: Bun.Subprocess | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let dir = "";
let beating: ReturnType<typeof setInterval> | null = null;

afterEach(async () => {
  if (beating) clearInterval(beating);
  beating = null;
  // Only ever the process we started ourselves, by handle.
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = null;
  upstream?.stop(true);
  upstream = null;
  if (dir) await cleanup(dir);
});

async function launch(): Promise<{ listenPort: number; statusFile: string; livenessFile: string }> {
  dir = await tempDir();
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("spawned upstream") });
  const listenPort = freePort();
  await writeRoutes(join(dir, "routes.json"), [route(listenPort, upstream.port!, "spawned.test")]);

  const livenessFile = join(dir, "liveness");
  await Bun.write(livenessFile, "");
  beating = setInterval(() => void Bun.write(livenessFile, String(Date.now())), 40);

  child = Bun.spawn([bun, "run", entry], {
    env: {
      ...process.env,
      LA_CONFIG_DIR: dir,
      NODE_ENV: "production", // this test process runs with NODE_ENV=test; the tray does not
      LA_LIVENESS_INTERVAL_MS: "50",
      LA_LIVENESS_TIMEOUT_MS: "200",
      LA_FORWARDER_QUIET: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const statusFile = join(dir, "forwarder-status.json");
  await waitFor(() => Bun.file(statusFile).exists(), { timeoutMs: 10_000, what: "the forwarder to publish status" });
  return { listenPort, statusFile, livenessFile };
}

test("it forwards, then exits on its own when the liveness file goes away", async () => {
  const { listenPort, statusFile, livenessFile } = await launch();
  expect(await httpGet(listenPort)).toBe("spawned upstream");

  // The app stops: no more heartbeat, and the file is removed.
  if (beating) clearInterval(beating);
  beating = null;
  await rm(livenessFile);

  const exitCode = await child!.exited;
  expect(exitCode).toBe(0);
  expect(await Bun.file(statusFile).exists()).toBe(false); // no stale pid left behind
}, 20_000);

test("loading the entrypoint under a test runner starts nothing", async () => {
  // `bun test` reports import.meta.main === true for every file it loads, so the entry has
  // to refuse to start itself there — otherwise a test run binds ports for real.
  dir = await tempDir();
  const probe = join(dir, "entry.test.ts");
  await Bun.write(probe, `import { expect, test } from "bun:test";\nimport * as entry from ${JSON.stringify(entry)};\ntest("imported", () => expect(typeof entry.main).toBe("function"));\n`);

  const proc = Bun.spawn([bun, "test", probe], {
    cwd: dir,
    env: { ...process.env, LA_CONFIG_DIR: dir, LA_FORWARDER_QUIET: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
  expect(await Bun.file(join(dir, "forwarder-status.json")).exists()).toBe(false);
}, 20_000);

test("SIGTERM shuts it down cleanly", async () => {
  const { listenPort, statusFile } = await launch();
  expect(await httpGet(listenPort)).toBe("spawned upstream");

  child!.kill("SIGTERM");
  const exitCode = await child!.exited;
  expect(exitCode).toBe(0);
  expect(await Bun.file(statusFile).exists()).toBe(false);
}, 20_000);
