/**
 * Node-side control of the fake helper.
 *
 * The Playwright runner is a Node process and `Bun.serve({ unix })` is a Bun API,
 * so the fake helper always runs as a `bun` child process. This module owns its
 * lifecycle (start / stop, via a pid file so any worker can reach it) and speaks
 * its protocol over the unix socket with `node:http`, which supports `socketPath`
 * natively.
 *
 * `startHelper()` and `stopHelper()` are both idempotent: a spec declares the
 * state it needs and does not care what the previous spec left behind.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";
import type { ApplyRequest, HelperStatus } from "@localhost-aliases/core";
import {
  FAKE_HELPER,
  HELPER_LOG,
  JOURNAL_PATH,
  PID_PATH,
  SOCKET_PATH,
  STATE_DIR,
  withE2eEnv,
} from "./paths";

export interface JournalEntry {
  at: string;
  request: ApplyRequest;
}

const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: payload ? { "content-type": "application/json" } : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Null when nothing is listening — the "helper not running" state under test. */
export async function helperStatus(): Promise<HelperStatus | null> {
  try {
    const res = await call("GET", "/status");
    return res.status === 200 ? (JSON.parse(res.text) as HelperStatus) : null;
  } catch {
    return null;
  }
}

/** Pushes a desired state directly, bypassing the dashboard. Used to reset. */
export async function applyDesiredState(request: ApplyRequest): Promise<void> {
  const res = await call("POST", "/apply", request);
  if (res.status !== 200) throw new Error(`fake helper rejected apply: ${res.text}`);
}

export async function applyEmpty(): Promise<void> {
  await applyDesiredState({ httpPort: 80, httpsPort: 443, routes: [], tls: null });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startHelper(): Promise<void> {
  if ((await helperStatus()) !== null) return;

  mkdirSync(STATE_DIR, { recursive: true });
  removeSocket();

  const log = openSync(HELPER_LOG, "a");
  // Detached so the child outlives the worker that happened to start it; the pid
  // file is what lets a different process (or globalTeardown) stop it later.
  const child = spawn("bun", [FAKE_HELPER], {
    cwd: dirname(FAKE_HELPER),
    env: withE2eEnv(),
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (child.pid !== undefined) writeFileSync(PID_PATH, String(child.pid));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await helperStatus()) !== null) return;
    await sleep(POLL_MS);
  }
  throw new Error(`fake helper did not come up on ${SOCKET_PATH}\n${tailLog()}`);
}

export async function stopHelper(): Promise<void> {
  const pid = readPid();
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await helperStatus()) === null) break;
    await sleep(POLL_MS);
  }

  // The absent socket file is what makes `helperAvailability()` report
  // "not installed" — the real first-run state the resilience spec asserts.
  removeSocket();
  rmSync(PID_PATH, { force: true });
}

function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function removeSocket(): void {
  try {
    if (existsSync(SOCKET_PATH) && statSync(SOCKET_PATH).isSocket()) unlinkSync(SOCKET_PATH);
  } catch {
    // Nothing to clean up.
  }
}

function tailLog(): string {
  if (!existsSync(HELPER_LOG)) return "(no helper log)";
  return readFileSync(HELPER_LOG, "utf8").split("\n").slice(-20).join("\n");
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export function readJournal(): JournalEntry[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearJournal(): void {
  rmSync(JOURNAL_PATH, { force: true });
}

export function lastApply(): ApplyRequest | null {
  const entries = readJournal();
  return entries.length === 0 ? null : (entries[entries.length - 1]?.request ?? null);
}

/**
 * The UI updates optimistically, so a row can be on screen before the dashboard
 * has finished pushing to the helper. Every "the helper received it" assertion
 * therefore polls rather than reading once.
 */
export async function waitForApply(
  predicate: (request: ApplyRequest) => boolean,
  timeoutMs = 10_000,
): Promise<ApplyRequest> {
  const deadline = Date.now() + timeoutMs;
  let seen: ApplyRequest[] = [];
  while (Date.now() < deadline) {
    seen = readJournal().map((entry) => entry.request);
    const match = [...seen].reverse().find(predicate);
    if (match) return match;
    await sleep(POLL_MS);
  }
  throw new Error(
    `no ApplyRequest matched within ${timeoutMs}ms. Journal:\n${JSON.stringify(seen, null, 2)}`,
  );
}
