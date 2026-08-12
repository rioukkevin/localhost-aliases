/**
 * Boots the real packages/web dashboard for a test, hermetically.
 *
 * Two hazards this fixture exists to remove:
 *
 *  - `next dev` wipes and rebuilds its `distDir`. Pointed at the default `.next`, one test
 *    run destroys the production build, so a build-then-start flow breaks afterwards. Every
 *    run therefore gets `LA_NEXT_DIST_DIR` (default `.next-test`), which nothing ships from.
 *  - a dashboard that fails to boot used to look exactly like a slow cold compile: the old
 *    inline fixture waited 180s in silence and only then read the child's stderr. Here the
 *    child's output is buffered from the first byte, echoed live once the wait stops looking
 *    like a normal compile, and attached to every failure — including an early exit, which
 *    fails immediately instead of burning the whole timeout.
 */
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WEB_DIR = join(REPO_ROOT, "packages/web");

/** Past this, a cold Next.js compile is no longer a plausible explanation. */
const ECHO_AFTER_MS = 15_000;
const READY_TIMEOUT_MS = 150_000;

export interface WebDashboard {
  port: number;
  /** Everything the child has written to stdout+stderr so far. */
  logs(): string;
  stop(): Promise<void>;
}

export interface WebDashboardOptions {
  port: number;
  /** Temp dir for config, CA, hosts file and helper socket: nothing real is touched. */
  configDir: string;
  /** Build tree, relative to packages/web. Never ".next". */
  distDir?: string;
}

export async function startWebDashboard(options: WebDashboardOptions): Promise<WebDashboard> {
  const { port, configDir } = options;
  const distDir = options.distDir ?? ".next-test";
  if (distDir === ".next") throw new Error("the test dashboard must not share the production .next build");

  // `bun run dev` and not `next dev`: the package script carries the --bun flag, without
  // which the server re-execs under Node and every core call dies on `Bun is not defined`.
  const child = spawn(["bun", "run", "dev"], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      LA_CONFIG_DIR: configDir,
      LA_DASHBOARD_PORT: String(port),
      LA_NEXT_DIST_DIR: distDir,
      // Defence in depth: even with a real helper installed, this dashboard can neither
      // reach it nor write the real hosts file.
      LA_SOCKET_PATH: join(configDir, "helper.sock"),
      LA_HOSTS_PATH: join(configDir, "hosts"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const buffered: string[] = [];
  let echo = false;
  const logs = () => buffered.join("");

  for (const [name, stream] of [["out", child.stdout], ["err", child.stderr]] as const) {
    void pump(stream, (text) => {
      buffered.push(text);
      if (echo) process.stderr.write(prefix(text, name));
    });
  }

  let exitCode: number | null = null;
  void child.exited.then((code) => {
    exitCode = code;
  });

  const started = Date.now();
  for (;;) {
    if (exitCode !== null) {
      throw fail(`the dashboard exited with code ${exitCode} before answering on :${port}`, logs());
    }
    if (!echo && Date.now() - started > ECHO_AFTER_MS) {
      echo = true;
      process.stderr.write(`\n--- packages/web is slow to start; streaming its output ---\n`);
      process.stderr.write(prefix(logs(), "out"));
    }
    if (Date.now() - started > READY_TIMEOUT_MS) {
      await stop(child);
      throw fail(`the dashboard never answered on :${port} within ${READY_TIMEOUT_MS}ms`, logs());
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }

  return { port, logs, stop: () => stop(child) };
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onText(decoder.decode(value));
  }
}

function prefix(text: string, stream: string): string {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `[web:${stream}] ${line}\n`)
    .join("");
}

function fail(message: string, logs: string): Error {
  return new Error(`${message}\n--- packages/web output ---\n${logs.slice(-8000) || "(nothing)"}`);
}

async function stop(child: Subprocess): Promise<void> {
  child.kill();
  await child.exited;
}
