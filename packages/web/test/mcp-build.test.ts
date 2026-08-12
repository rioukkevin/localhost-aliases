/**
 * The MCP spec must survive a REAL Next production build.
 *
 * Core derives the MCP entrypoint from its own module location. Under `bun test`
 * that always works; inside a webpack bundle it does not, and that difference is
 * exactly how `GET /api/mcp` shipped returning `spec: null` and
 * `POST /api/mcp/install` returning 500 while every unit test stayed green.
 *
 * So this test refuses to import anything: it builds the dashboard, starts it the
 * way the tray and launchd do (`bun run start`, i.e. `bun --bun next start`), and
 * talks to it over HTTP against throwaway config paths.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const WEB_DIR = resolve(import.meta.dir, "..");
const ENTRYPOINT_SUFFIX = join("packages", "mcp", "src", "index.ts");
const BOOT_TIMEOUT_MS = 60_000;
/** Relative to packages/web. Anything but ".next", which the real server owns. */
const DIST_DIR = ".next-test-mcp";

interface Started {
  proc: Bun.Subprocess;
  port: number;
  claudeConfig: string;
  codexConfig: string;
}

let started: Started | null = null;
let dir: string | null = null;

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = Number(server.port);
  server.stop(true);
  return port;
}

/** Hermetic: temp config paths, and a build tree that is never the production `.next`. */
function childEnv(port: number, temp: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Proving the AUTOMATIC resolution is the whole point of this file.
  delete env.LA_MCP_ENTRYPOINT;
  return {
    ...env,
    LA_DASHBOARD_PORT: String(port),
    LA_CONFIG_DIR: join(temp, "config"),
    LA_CLAUDE_CONFIG: join(temp, "claude", ".claude.json"),
    LA_CODEX_CONFIG: join(temp, "codex", "config.toml"),
    // Own build tree: never touches the production build, never fights another server.
    LA_NEXT_DIST_DIR: DIST_DIR,
    // Defence in depth: this server can reach neither the helper nor the real hosts file.
    LA_SOCKET_PATH: join(temp, "helper.sock"),
    LA_HOSTS_PATH: join(temp, "hosts"),
  };
}

async function build(env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: WEB_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`next build failed (${code}):\n${stderr}`);
}

async function waitForHealth(port: number, proc: Bun.Subprocess, log: () => string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`the server exited early: ${log()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new Error(`no /api/health within ${BOOT_TIMEOUT_MS}ms: ${log()}`);
}

async function start(): Promise<Started> {
  const temp = mkdtempSync(join(tmpdir(), "la-web-build-"));
  dir = temp;
  const port = freePort();
  const env = childEnv(port, temp);
  await build(env);

  // Via the package script on purpose: launching `next` directly drops the
  // `--bun` flag and every route handler dies with "Bun is not defined".
  const proc = Bun.spawn(["bun", "run", "start"], {
    cwd: WEB_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drained, not ignored: an undrained pipe blocks the server once it fills, and
  // the output is the only clue when the boot fails.
  const output = { text: "" };
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      output.text += decoder.decode(value);
    }
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
  void collect(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});

  await waitForHealth(port, proc, () => output.text);
  started = { proc, port, claudeConfig: env.LA_CLAUDE_CONFIG!, codexConfig: env.LA_CODEX_CONFIG! };
  return started;
}

/** Built and started once, on first use; every test awaits the same promise. */
let booting: Promise<Started> | null = null;
function boot(): Promise<Started> {
  booting ??= start();
  return booting;
}

afterAll(async () => {
  if (started !== null) {
    started.proc.kill();
    await started.proc.exited;
    // `bun run` spawns the real server as a child, so it can outlive its parent.
    Bun.spawnSync(["/bin/sh", "-c", `pids=$(lsof -ti tcp:${started.port}); [ -n "$pids" ] && kill -9 $pids || true`]);
  }
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
});

test("GET /api/mcp resolves a spec whose entrypoint exists on disk", async () => {
  const { port } = await boot();
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp`);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.reason).toBeNull();
  expect(body.spec).not.toBeNull();
  expect(body.spec.command).toBe("bun");

  const entrypoint = body.spec.args[0];
  expect(isAbsolute(entrypoint)).toBe(true);
  expect(entrypoint.endsWith(ENTRYPOINT_SUFFIX)).toBe(true);
  expect(existsSync(entrypoint)).toBe(true);
  expect(body.spec.env.LA_DASHBOARD_PORT).toBe(String(port));
  expect(body.snippets.claude).toContain(entrypoint);
  expect(body.snippets.codex).toContain(entrypoint);
}, 180_000);

test("POST /api/mcp/install writes both client configs", async () => {
  const { port, claudeConfig, codexConfig } = await boot();
  const entrypoint = (await (await fetch(`http://127.0.0.1:${port}/api/mcp`)).json()).spec.args[0];

  const claudeRes = await fetch(`http://127.0.0.1:${port}/api/mcp/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "claude" }),
  });
  expect(claudeRes.status).toBe(200);
  expect((await claudeRes.json()).configPath).toBe(claudeConfig);
  const claudeJson = JSON.parse(await Bun.file(claudeConfig).text());
  expect(claudeJson.mcpServers["localhost-aliases"].args).toEqual([entrypoint]);

  const codexRes = await fetch(`http://127.0.0.1:${port}/api/mcp/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "codex" }),
  });
  expect(codexRes.status).toBe(200);
  expect((await codexRes.json()).configPath).toBe(codexConfig);
  const toml = await Bun.file(codexConfig).text();
  expect(toml).toContain("[mcp_servers.localhost_aliases]");
  expect(toml).toContain(`args = ["${entrypoint}"]`);

  // The temp files are the only ones touched.
  expect(dirname(dirname(claudeConfig))).toBe(String(dir));
}, 180_000);

test("the server-rendered /mcp page carries the same entrypoint", async () => {
  const { port } = await boot();
  const entrypoint = (await (await fetch(`http://127.0.0.1:${port}/api/mcp`)).json()).spec.args[0];
  const html = await (await fetch(`http://127.0.0.1:${port}/mcp`)).text();
  expect(html).toContain(entrypoint);
}, 180_000);
