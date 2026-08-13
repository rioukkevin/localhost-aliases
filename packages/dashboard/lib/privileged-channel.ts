/**
 * The dashboard <-> tray request channel, whole, in one file.
 *
 * A web page cannot raise a macOS admin prompt, and the dashboard process is unprivileged
 * by design. So a click here writes a REQUEST file; the menu-bar app polls it, runs the
 * privileged work behind the one admin prompt, and writes a RESULT file back. Two plain
 * JSON files in the user's own config dir — no port, no socket, nothing to authenticate.
 *
 * Nothing in this module runs a privileged command, and nothing in it may ever start to.
 */
import { stat } from "node:fs/promises";
import {
  APPLY_REQUEST_TTL_MS,
  LIVENESS_TIMEOUT_MS,
  applyRequestPath,
  applyResultPath,
  buildDesiredState,
  livenessPath,
  loadConfig,
  type PrivilegedKind,
  type PrivilegedProgress,
  type PrivilegedRequest,
  type PrivilegedResult,
} from "@localhost-aliases/core";
import { readJsonOrNull, writeJsonAtomic } from "./files.ts";
import { writeRuntimeFiles } from "./service.ts";

const KINDS: readonly PrivilegedKind[] = ["apply", "uninstall"];

export function isPrivilegedKind(value: unknown): value is PrivilegedKind {
  return typeof value === "string" && KINDS.includes(value as PrivilegedKind);
}

// --- reading the two files --------------------------------------------------
//
// Both files are absent on a fresh machine and can be half-written by a crashed run,
// so every read fails soft: a missing or malformed file means "nothing was asked",
// never an exception in a route handler.

function isRequest(value: unknown): value is PrivilegedRequest {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<PrivilegedRequest>;
  return typeof r.id === "string" && r.id !== "" && isPrivilegedKind(r.kind) && typeof r.requestedAt === "string";
}

function isResult(value: unknown): value is PrivilegedResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<PrivilegedResult>;
  return (
    typeof r.id === "string" &&
    r.id !== "" &&
    isPrivilegedKind(r.kind) &&
    typeof r.ok === "boolean" &&
    typeof r.finishedAt === "string"
  );
}

async function readRequest(): Promise<PrivilegedRequest | null> {
  const raw = await readJsonOrNull<unknown>(applyRequestPath());
  return isRequest(raw) ? raw : null;
}

async function readResult(): Promise<PrivilegedResult | null> {
  const raw = await readJsonOrNull<unknown>(applyResultPath());
  return isResult(raw) ? raw : null;
}

/**
 * Is the menu-bar app running? It touches the liveness file every few seconds; if that
 * stopped, nothing will ever pick a request up and the UI has to say so instead of
 * spinning forever. The mtime is the signal — the file's contents are the tray's business.
 */
export async function isTrayAlive(now = Date.now()): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(livenessPath());
    return now - mtimeMs <= LIVENESS_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function ageMs(iso: string, now: number): number {
  const at = Date.parse(iso);
  // An unparseable timestamp is treated as ancient: better to report a stale request
  // than to leave the UI waiting on one that may never be answered.
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
}

// --- asking ------------------------------------------------------------------

/**
 * Ask the tray for one privileged run.
 *
 * The desired state is refreshed FIRST: the tray hands the script a file path, so the
 * files must already describe the current intent when it picks the request up.
 */
export async function requestPrivileged(kind: PrivilegedKind = "apply"): Promise<PrivilegedRequest> {
  if (kind === "apply") {
    await writeRuntimeFiles(buildDesiredState(await loadConfig()));
  }
  const request: PrivilegedRequest = {
    id: crypto.randomUUID(),
    kind,
    requestedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(applyRequestPath(), request);
  return request;
}

// --- watching ----------------------------------------------------------------

/** A request nobody answered in time. Reported as a finished failure, never as pending. */
function timedOut(request: PrivilegedRequest, trayAlive: boolean, now: number): PrivilegedResult {
  return {
    id: request.id,
    kind: request.kind,
    ok: false,
    cancelled: false,
    error: trayAlive
      ? "The menu-bar app did not answer this request. Open its menu and choose Apply changes, or run the command below yourself."
      : "The Localhost Aliases menu-bar app is not running, so nothing picked this up. Start it and try again, or run the command below yourself.",
    startedAt: request.requestedAt,
    finishedAt: new Date(now).toISOString(),
  };
}

/**
 * What the dashboard shows while it waits.
 *
 * With an `id`, only that request and its result count — a leftover result from an
 * earlier run must never be mistaken for the answer to this one. Without an `id` the
 * last request on disk is described, which is what a freshly loaded page needs.
 */
export async function readProgress(id?: string, now = Date.now()): Promise<PrivilegedProgress> {
  const [storedRequest, storedResult, trayAlive] = await Promise.all([
    readRequest(),
    readResult(),
    isTrayAlive(now),
  ]);

  const wanted = id ?? storedRequest?.id ?? null;
  const request = wanted !== null && storedRequest?.id === wanted ? storedRequest : null;
  const result = wanted !== null && storedResult?.id === wanted ? storedResult : null;

  if (result) return { state: "done", trayAlive, request, result };
  if (request) {
    if (ageMs(request.requestedAt, now) <= APPLY_REQUEST_TTL_MS) {
      return { state: "pending", trayAlive, request, result: null };
    }
    return { state: "done", trayAlive, request, result: timedOut(request, trayAlive, now) };
  }
  return { state: "idle", trayAlive, request: null, result: null };
}
