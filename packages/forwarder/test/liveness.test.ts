/**
 * The forwarder is root and the app cannot kill it, so this timer is the only thing that
 * stops it. Exiting when the app is alive would kill everyone's forwarding, so the tests
 * push hardest on the cases where it must *not* fire.
 */
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { watchLiveness } from "../src/liveness.ts";
import { cleanup, tempDir, waitFor } from "./helpers.ts";

let dir: string;
const stoppers: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  await cleanup(dir);
});

test("a file that keeps being touched never expires", async () => {
  dir = await tempDir();
  const path = join(dir, "liveness");
  await Bun.write(path, "");
  const reasons: string[] = [];
  const watcher = watchLiveness({
    path,
    intervalMs: 20,
    timeoutMs: 100,
    onExpire: (r) => reasons.push(r),
  });
  stoppers.push(() => watcher.stop());

  for (let i = 0; i < 12; i++) {
    await Bun.sleep(25);
    await Bun.write(path, String(Date.now()));
  }
  expect(reasons).toEqual([]);
});

test("a file that stops being touched expires", async () => {
  dir = await tempDir();
  const path = join(dir, "liveness");
  await Bun.write(path, "");
  const reasons: string[] = [];
  const watcher = watchLiveness({
    path,
    intervalMs: 20,
    timeoutMs: 60,
    onExpire: (r) => reasons.push(r),
  });
  stoppers.push(() => watcher.stop());

  await waitFor(() => reasons.length === 1, { what: "the liveness watcher to give up" });
  expect(reasons[0]).toContain("old");
});

test("one stale reading is not enough", async () => {
  dir = await tempDir();
  const path = join(dir, "liveness");
  await Bun.write(path, "");
  await utimes(path, new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));
  let expired = false;
  const watcher = watchLiveness({
    path,
    intervalMs: 40,
    timeoutMs: 100,
    misses: 3,
    onExpire: () => {
      expired = true;
    },
  });
  stoppers.push(() => watcher.stop());

  await Bun.sleep(60); // one tick has run, and it saw a stale file
  expect(expired).toBe(false);
  await waitFor(() => expired, { what: "three strikes" });
});

test("a missing file is tolerated until the grace period is over", async () => {
  dir = await tempDir();
  const path = join(dir, "liveness"); // never created
  let expired = false;
  const watcher = watchLiveness({
    path,
    intervalMs: 20,
    timeoutMs: 50,
    graceMs: 300,
    onExpire: () => {
      expired = true;
    },
  });
  stoppers.push(() => watcher.stop());

  await Bun.sleep(150);
  expect(expired).toBe(false); // the app may simply not have written it yet
  await waitFor(() => expired, { what: "the grace period to run out" });
});

test("a filesystem error that is not 'missing' never counts against the app", async () => {
  dir = await tempDir();
  const locked = join(dir, "locked");
  await mkdir(locked);
  const path = join(locked, "liveness");
  await Bun.write(path, "");
  await chmod(locked, 0o000); // stat now fails with EACCES, not ENOENT
  let expired = false;
  const watcher = watchLiveness({
    path,
    intervalMs: 20,
    timeoutMs: 50,
    graceMs: 0,
    onExpire: () => {
      expired = true;
    },
  });
  stoppers.push(() => watcher.stop());

  await Bun.sleep(250);
  await chmod(locked, 0o755);
  expect(expired).toBe(false);
});

test("a stalled process gets a fresh chance instead of exiting", async () => {
  dir = await tempDir();
  const path = join(dir, "liveness");
  await Bun.write(path, "");
  // Fake clock: the file is ancient, so only the late-tick rule can save it.
  const epoch = Date.now();
  let clock = epoch;
  await utimes(path, new Date(epoch - 60_000), new Date(epoch - 60_000));
  let expired = false;
  const watcher = watchLiveness({
    path,
    intervalMs: 20,
    timeoutMs: 1_000,
    graceMs: 0,
    now: () => clock,
    onExpire: () => {
      expired = true;
    },
  });
  stoppers.push(() => watcher.stop());

  // Every tick lands far later than scheduled — the process was stalled, not the app.
  const jump = setInterval(() => {
    clock += 200;
  }, 10);
  await Bun.sleep(400);
  clearInterval(jump);
  expect(expired).toBe(false);

  // Once time behaves again, the ancient file is judged on its merits.
  await waitFor(() => expired, { what: "the stale file to be acted on" });
});
