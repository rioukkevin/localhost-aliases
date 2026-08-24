/**
 * Launch at login — the dashboard's half of the contract in apps/tray/Sources/LoginItem.swift.
 *
 * Only the Swift side can call `SMAppService.mainApp.register()` and only it can read
 * `SMAppService.mainApp.status`. A web page cannot, and the dashboard never runs a
 * privileged or AppKit call. So this is the same two-plain-files channel the admin prompt
 * already uses: no port, no URL scheme, nothing to authenticate, both files inside the
 * user's own config directory.
 *
 *   <configDir>/login-item.json          WRITTEN BY THE TRAY, read by us.
 *     { "status": "enabled" | "requiresApproval" | "notRegistered" | "notFound" | "unknown",
 *       "enabled": bool,            // true ONLY for `enabled` — approval outstanding is not on
 *       "canToggle": bool,          // false for notFound: there is no bundle to register
 *       "needsSystemSettings": bool,
 *       "headline": string, "detail": string, "warning": string,
 *       "systemSettingsUrl": string,
 *       "lastRequestId": string|null,   // the ask this status answered
 *       "updatedAt": "<ISO 8601>" }
 *
 *   <configDir>/login-item-request.json  WRITTEN BY US, read and then DELETED by the tray.
 *     { "id": "<uuid>", "action": "enable"|"disable"|"refresh", "requestedAt": "<ISO 8601>" }
 *
 * The tray registers or unregisters, republishes login-item.json with the status it read
 * back from the system — never with the value it was handed — and removes the request.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a missing, unreadable, malformed or
 * unrecognised file reads as `"unknown"`. It never reads as "off". "Launch at login is off"
 * is a claim about the user's Mac, and we do not make it because a file we hoped for was
 * not there — the tray may not have got to its first publish yet, or may be an older build.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { APPLY_REQUEST_TTL_MS, configDir } from "@localhost-aliases/core";
import { readJsonOrNull, writeJsonAtomic } from "./files.ts";

/** `SMAppService.Status` as the tray names it, plus "we have not been told". */
export type LaunchAtLoginStatus =
  | "enabled"
  | "requiresApproval"
  | "notRegistered"
  | "notFound"
  | "unknown";

export type LaunchAtLoginAction = "enable" | "disable" | "refresh";

const KNOWN: readonly string[] = ["enabled", "requiresApproval", "notRegistered", "notFound"];
const ACTIONS: readonly string[] = ["enable", "disable", "refresh"];

export function loginItemPath(): string {
  return join(configDir(), "login-item.json");
}
export function loginItemRequestPath(): string {
  return join(configDir(), "login-item-request.json");
}

export interface LaunchAtLoginState {
  status: LaunchAtLoginStatus;
  /**
   * The tray's own boolean, never one we inferred. `null` while the status is unknown —
   * which is the whole point: an absent answer is not `false`.
   */
  enabled: boolean | null;
  /** False when there is nothing to register (a dev build outside an .app). `null` if unknown. */
  canToggle: boolean | null;
  /** The user has to finish the job in System Settings; the switch cannot. */
  needsSystemSettings: boolean;
  /** Only the tray knows this URL, so we pass it through rather than hardcoding it. */
  systemSettingsUrl: string | null;
  /** When the tray last read the system. Null whenever the status is unknown. */
  updatedAt: string | null;
  /** An ask the tray has not answered yet. */
  pending: boolean;
  /** What that pending ask was, so the UI can show the move optimistically. */
  requested: LaunchAtLoginAction | null;
}

export const UNKNOWN_LAUNCH_AT_LOGIN: LaunchAtLoginState = {
  status: "unknown",
  enabled: null,
  canToggle: null,
  needsSystemSettings: false,
  systemSettingsUrl: null,
  updatedAt: null,
  pending: false,
  requested: null,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read the current state. Every failure mode — no file, empty file, truncated JSON, a
 * status string from a future version — lands on `unknown`.
 */
export async function readLaunchAtLogin(now: number = Date.now()): Promise<LaunchAtLoginState> {
  const raw = await readJsonOrNull<unknown>(loginItemPath());
  const request = await readJsonOrNull<unknown>(loginItemRequestPath());

  const published = isObject(raw) ? raw : null;
  const status: LaunchAtLoginStatus =
    published && typeof published.status === "string" && KNOWN.includes(published.status)
      ? (published.status as LaunchAtLoginStatus)
      : "unknown";
  const known = status !== "unknown";

  // The tray deletes the request once it has answered, so a file that is still there is
  // either unanswered or stale. `lastRequestId` settles the race where a poll lands between
  // the tray's publish and its unlink.
  const asked = isObject(request) ? request : null;
  const askId = asked ? text(asked.id) : null;
  const action =
    asked && typeof asked.action === "string" && ACTIONS.includes(asked.action)
      ? (asked.action as LaunchAtLoginAction)
      : null;
  const askedAt = asked ? toIso(asked.requestedAt) : null;
  const answered = askId !== null && published?.lastRequestId === askId;
  const stale = askedAt !== null && now - Date.parse(askedAt) > APPLY_REQUEST_TTL_MS;
  const pending = action !== null && askId !== null && !answered && !stale;

  return {
    status,
    // `enabled` is the tray's word, and it is deliberately false while approval is
    // outstanding. We only fall back to deriving it if the tray omitted the field.
    enabled: !known ? null : typeof published?.enabled === "boolean" ? published.enabled : status === "enabled",
    canToggle: !known ? null : typeof published?.canToggle === "boolean" ? published.canToggle : true,
    needsSystemSettings: known
      ? published?.needsSystemSettings === true || status === "requiresApproval"
      : false,
    systemSettingsUrl: published ? text(published.systemSettingsUrl) : null,
    updatedAt: known ? toIso(published?.updatedAt) : null,
    pending,
    requested: pending ? action : null,
  };
}

/**
 * Ask the tray to register, unregister, or simply re-read and republish. We write the ask
 * and return the state as it STILL IS — we do not pretend it has taken effect, because only
 * the tray can know that, and it has to read `SMAppService.Status` back to find out.
 */
export async function requestLaunchAtLogin(action: LaunchAtLoginAction): Promise<LaunchAtLoginState> {
  await writeJsonAtomic(loginItemRequestPath(), {
    id: randomUUID(),
    action,
    requestedAt: new Date().toISOString(),
  });
  const state = await readLaunchAtLogin();
  return { ...state, pending: true, requested: action };
}
