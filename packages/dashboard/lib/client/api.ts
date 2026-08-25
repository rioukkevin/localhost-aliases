/**
 * Every call the client makes, and the only place an endpoint name appears.
 *
 * The wire shapes mirror lib/service.ts, but they are declared here rather than
 * imported from it: the client must not reach into a module that opens files and
 * spawns processes, even for a type.
 *
 *   GET    /api/status                 the polled snapshot: config + aliases + system + sync
 *   POST   /api/aliases                CreateAliasInput            -> { alias, sync }
 *   PATCH  /api/aliases/:id            UpdateAliasInput            -> { alias, sync }
 *   DELETE /api/aliases/:id                                        -> { deleted, sync }
 *   GET    /api/projects                                           -> { projects }
 *   POST   /api/projects/link          { path, aliasIds?, ... }    -> LinkProjectResult
 *   POST   /api/projects/workspace     { path }                    -> { path, workspaceFile }
 *   POST   /api/pick-folder                                        -> { path, cancelled }
 *   GET    /api/offline                ?host=…                     -> OfflineView
 *   GET    /api/launch-at-login                                    -> LaunchAtLoginState
 *   PUT    /api/launch-at-login        { action }                  -> LaunchAtLoginState
 *   GET    /api/onboarding                                         -> OnboardingPayload
 *   POST   /api/onboarding             { action, ... }             -> OnboardingPayload
 *   PATCH  /api/settings               { tld?, dashboardPort?, https?, autoApply? } -> { config, restartRequired }
 *   POST   /api/apply                  (prepares only, never runs root work)
 *   POST   /api/privileged/request     { kind }                    -> { request, trayAlive }
 *   GET    /api/privileged/progress    ?id=…                       -> PrivilegedProgress
 */
import type {
  Alias,
  AliasView,
  Config,
  CreateAliasInput,
  OnboardingStep,
  OnboardingStepId,
  PrivilegedKind,
  PrivilegedProgress,
  PrivilegedRequest,
  Project,
  SystemState,
  UpdateAliasInput,
  ValidationIssue,
} from "@localhost-aliases/core/types";

export class ApiError extends Error {
  readonly status: number;
  readonly issues: ValidationIssue[];
  constructor(message: string, status: number, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

type Json = Record<string, unknown>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(`Cannot reach the dashboard server (${errorMessage(err)}).`, 0);
  }

  const text = await res.text();
  let body: Json = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const message =
      (typeof body.error === "string" && body.error) ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, (body.issues as ValidationIssue[] | undefined) ?? []);
  }
  return body as T;
}

const send = <T = Json,>(path: string, method: string, payload?: unknown) =>
  request<T>(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

// ---------------------------------------------------------------------------
// Shared wire shapes (mirrors of lib/service.ts)
// ---------------------------------------------------------------------------

/** What only root can do, and the exact command that will do it. */
export interface ApplyIntent {
  required: boolean;
  reasons: string[];
  script: string;
  desiredStatePath: string;
  routesPath: string;
  command: string[];
}

/** The diff between the config and the live machine. */
export interface SyncReport {
  applied: boolean;
  needsPrompt: boolean;
  drift: string[];
  privileged: string[];
  /** Drift the running forwarder fixes on its own once routes.json changes. */
  unprivileged: string[];
  intent: ApplyIntent;
}

/**
 * Where automatic apply stands, as published by lib/service.ts. Mirrored here rather
 * than imported for the reason at the top of this file. `null` means the server did not
 * say — an older build, or a response that predates the field — and the UI reads that as
 * idle, which is byte-for-byte the manual behaviour.
 */
export interface AutoApplyStatus {
  state: "idle" | "scheduled" | "prompting" | "deferred" | "failed";
  enabled: boolean;
  requestId: string | null;
  scheduledInMs: number | null;
  dirty: boolean;
  error: string | null;
  reason: string | null;
}

const AUTO_APPLY_STATES = new Set(["idle", "scheduled", "prompting", "deferred", "failed"]);

/** Fails soft: anything the server did not send, or sent malformed, becomes null. */
export function toAutoApplyStatus(value: unknown): AutoApplyStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || !AUTO_APPLY_STATES.has(raw.state)) return null;
  return {
    state: raw.state as AutoApplyStatus["state"],
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    requestId: typeof raw.requestId === "string" ? raw.requestId : null,
    scheduledInMs: typeof raw.scheduledInMs === "number" ? raw.scheduledInMs : null,
    dirty: raw.dirty === true,
    error: typeof raw.error === "string" && raw.error !== "" ? raw.error : null,
    reason: typeof raw.reason === "string" && raw.reason !== "" ? raw.reason : null,
  };
}

export interface StatusPayload {
  config: Config;
  aliases: AliasView[];
  system: SystemState;
  sync: SyncReport;
  dashboardHostname: string;
  capacity: { used: number; total: number; remaining: number };
  /**
   * Is the menu-bar app answering? `null` means the server did not say — never
   * `false`, because "the menu-bar app is not running" is a claim about the
   * user's machine and we only make it when the machine was actually asked.
   */
  trayAlive: boolean | null;
  /** The auto-apply reading. `null` when the server did not publish one. */
  autoApply: AutoApplyStatus | null;
  /** Certificate state. `null` when the server did not publish one — never a guess. */
  tls: TlsReading | null;
}

/** What the settings page needs to say something true about the padlock. */
export interface TlsReading {
  enabled: boolean;
  caReady: boolean;
  trusted: boolean;
  certReady: boolean;
  expiresInDays: number | null;
  trustCommand: string;
  /** Why the certificate could not be prepared. Null when nothing went wrong. */
  error: string | null;
}

/**
 * Never invent a reading. A missing or malformed field means "we do not know", and the UI
 * says "checking…" rather than telling the user their certificate is untrusted.
 */
export function toTlsReading(value: unknown): TlsReading | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.trustCommand !== "string") return null;
  const days = v.expiresInDays;
  return {
    enabled: v.enabled === true,
    caReady: v.caReady === true,
    trusted: v.trusted === true,
    certReady: v.certReady === true,
    expiresInDays: typeof days === "number" && Number.isFinite(days) ? days : null,
    trustCommand: v.trustCommand,
    error: typeof v.error === "string" && v.error !== "" ? v.error : null,
  };
}

const NO_SYNC: SyncReport = {
  applied: false,
  needsPrompt: false,
  drift: [],
  privileged: [],
  unprivileged: [],
  intent: {
    required: false,
    reasons: [],
    script: "",
    desiredStatePath: "",
    routesPath: "",
    command: [],
  },
};

export async function fetchStatus(): Promise<StatusPayload> {
  const body = await request<Partial<StatusPayload>>("/api/status");
  if (!body.config) throw new ApiError("The status response carried no config.", 500);
  return {
    config: body.config,
    aliases: body.aliases ?? [],
    system: body.system ?? {
      loopbackIps: [],
      managedHosts: [],
      forwarder: null,
      applied: false,
      drift: [],
    },
    sync: body.sync ?? NO_SYNC,
    dashboardHostname: body.dashboardHostname ?? `index.${body.config.tld}`,
    capacity: body.capacity ?? { used: 0, total: 253, remaining: 253 },
    trayAlive: typeof body.trayAlive === "boolean" ? body.trayAlive : null,
    autoApply: toAutoApplyStatus(body.autoApply),
    tls: toTlsReading(body.tls),
  };
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export async function createAlias(input: CreateAliasInput): Promise<Alias> {
  const body = await send<{ alias: Alias }>("/api/aliases", "POST", input);
  return body.alias;
}

export async function updateAlias(id: string, input: UpdateAliasInput): Promise<Alias> {
  const body = await send<{ alias: Alias }>(`/api/aliases/${encodeURIComponent(id)}`, "PATCH", input);
  return body.alias;
}

export async function deleteAlias(id: string): Promise<void> {
  await send(`/api/aliases/${encodeURIComponent(id)}`, "DELETE");
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** What we think starts a project, from packages/core/src/stack.ts. Advisory. */
export interface DetectedStack {
  framework: string;
  command: string;
  confidence: "high" | "low";
}

/**
 * Fails soft in both directions: a server that does not send `stack` (an older build)
 * and a server that sends something unrecognisable both land on `null`, which every
 * surface renders as "we do not recognise this folder" — never as a guessed framework.
 */
export function toDetectedStack(value: unknown): DetectedStack | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.framework !== "string" || raw.framework === "") return null;
  if (typeof raw.command !== "string" || raw.command === "") return null;
  return {
    framework: raw.framework,
    command: raw.command,
    confidence: raw.confidence === "high" ? "high" : "low",
  };
}

export interface ProjectPayload extends Project {
  stack: DetectedStack | null;
}

export async function fetchProjects(): Promise<ProjectPayload[]> {
  const body = await request<{ projects?: Array<Project & { stack?: unknown }> }>("/api/projects");
  return (body.projects ?? []).map((p) => ({ ...p, stack: toDetectedStack(p.stack) }));
}

// ---------------------------------------------------------------------------
// Offline page
// ---------------------------------------------------------------------------

export interface OfflineAlias {
  id: string;
  name: string;
  hostname: string;
  url: string;
  targetPort: number;
  ip: string;
  projectPath: string | null;
  enabled: boolean;
  reserved: boolean;
}

export interface OfflineView {
  hostname: string;
  known: boolean;
  alias: OfflineAlias | null;
  stack: DetectedStack | null;
  listening: boolean;
  checkedAt: string;
}

export async function fetchOffline(host: string): Promise<OfflineView> {
  const body = await request<Partial<OfflineView>>(
    `/api/offline?host=${encodeURIComponent(host)}`,
  );
  return {
    hostname: typeof body.hostname === "string" ? body.hostname : host,
    known: body.known === true,
    alias: body.alias ?? null,
    stack: toDetectedStack(body.stack),
    listening: body.listening === true,
    checkedAt: typeof body.checkedAt === "string" ? body.checkedAt : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Launch at login
// ---------------------------------------------------------------------------

/** `SMAppService.Status` as apps/tray/Sources/LoginItem.swift names it, plus "not told". */
export type LaunchAtLoginStatus =
  | "enabled"
  | "requiresApproval"
  | "notRegistered"
  | "notFound"
  | "unknown";

export type LaunchAtLoginAction = "enable" | "disable" | "refresh";

export interface LaunchAtLoginState {
  status: LaunchAtLoginStatus;
  /** The tray's own boolean. `null` while unknown — an absent answer is not `false`. */
  enabled: boolean | null;
  canToggle: boolean | null;
  needsSystemSettings: boolean;
  systemSettingsUrl: string | null;
  updatedAt: string | null;
  pending: boolean;
  requested: LaunchAtLoginAction | null;
}

const LAUNCH_STATES: readonly string[] = ["enabled", "requiresApproval", "notRegistered", "notFound"];
const LAUNCH_ACTIONS: readonly string[] = ["enable", "disable", "refresh"];

export const UNKNOWN_LAUNCH: LaunchAtLoginState = {
  status: "unknown",
  enabled: null,
  canToggle: null,
  needsSystemSettings: false,
  systemSettingsUrl: null,
  updatedAt: null,
  pending: false,
  requested: null,
};

/**
 * Anything the menu-bar app has not answered — a missing field, an older build, a value
 * from a future one — is "unknown", and unknown carries `enabled: null`. It is never
 * `false`: that would be a confident claim about the user's Mac made because a file was
 * absent.
 */
export function toLaunchAtLogin(value: unknown): LaunchAtLoginState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return UNKNOWN_LAUNCH;
  const raw = value as Record<string, unknown>;
  const status =
    typeof raw.status === "string" && LAUNCH_STATES.includes(raw.status)
      ? (raw.status as LaunchAtLoginStatus)
      : "unknown";
  if (status === "unknown") {
    return {
      ...UNKNOWN_LAUNCH,
      pending: raw.pending === true,
      requested:
        typeof raw.requested === "string" && LAUNCH_ACTIONS.includes(raw.requested)
          ? (raw.requested as LaunchAtLoginAction)
          : null,
    };
  }
  return {
    status,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : status === "enabled",
    canToggle: typeof raw.canToggle === "boolean" ? raw.canToggle : true,
    needsSystemSettings: raw.needsSystemSettings === true || status === "requiresApproval",
    systemSettingsUrl:
      typeof raw.systemSettingsUrl === "string" && raw.systemSettingsUrl !== ""
        ? raw.systemSettingsUrl
        : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    pending: raw.pending === true,
    requested:
      typeof raw.requested === "string" && LAUNCH_ACTIONS.includes(raw.requested)
        ? (raw.requested as LaunchAtLoginAction)
        : null,
  };
}

export async function fetchLaunchAtLogin(): Promise<LaunchAtLoginState> {
  return toLaunchAtLogin(await request<unknown>("/api/launch-at-login"));
}

export async function setLaunchAtLogin(action: LaunchAtLoginAction): Promise<LaunchAtLoginState> {
  return toLaunchAtLogin(await send<unknown>("/api/launch-at-login", "PUT", { action }));
}

export interface LinkProjectResult {
  project: Project;
  created: AliasView[];
  updated: AliasView[];
  workspaceFile: string | null;
}

/**
 * Attach a folder. With `importWorkspace` the server also adopts whatever the folder's
 * own .localhost-aliases.json declares — the whole point of the file.
 */
export async function linkProject(input: {
  path: string;
  aliasIds?: string[];
  importWorkspace?: boolean;
  writeWorkspaceFile?: boolean;
}): Promise<LinkProjectResult> {
  return send<LinkProjectResult>("/api/projects/link", "POST", input);
}

/**
 * Re-read a folder to see what runs in it now, ignoring the cached answer.
 *
 * `stack` is null when the folder is not recognised — that is the honest answer, not an
 * error, so callers render "we do not recognise this" rather than a failure.
 */
export async function rescanProject(path: string): Promise<{
  path: string;
  stack: DetectedStack | null;
  refreshed: boolean;
}> {
  const body = await send<{ path?: string; stack?: unknown; refreshed?: boolean }>(
    "/api/projects/rescan",
    "POST",
    { path },
  );
  return {
    path: body.path ?? path,
    stack: toDetectedStack(body.stack),
    refreshed: body.refreshed === true,
  };
}

export async function writeWorkspaceFile(path: string): Promise<string> {
  const body = await send<{ workspaceFile?: string; path?: string }>(
    "/api/projects/workspace",
    "POST",
    { path },
  );
  return body.workspaceFile ?? body.path ?? path;
}

/** Opens the native folder dialog. Resolves to null when the user cancels it. */
export async function pickFolder(): Promise<string | null> {
  const body = await send<{ path?: string | null; cancelled?: boolean }>("/api/pick-folder", "POST");
  return typeof body.path === "string" && body.path.length > 0 ? body.path : null;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export interface McpClientInfo {
  id: string;
  name: string;
  configured: boolean;
  path?: string;
  /** Present for clients we can only half-automate; the user pastes it. */
  snippet?: string;
}

export interface OnboardingPayload {
  steps: OnboardingStep[];
  complete: boolean;
  skipped: boolean;
  /** Exactly what the privileged batch will change, in the server's own words. */
  changes: string[];
  /** One sentence on the alias suffix, including why .local is not offered. */
  naming?: string;
  command: string | null;
  verifyUrl: string | null;
  mcpClients: McpClientInfo[];
  sync: SyncReport;
  /** Set by the apply step: what the menu-bar app must run under the one prompt. */
  intent: ApplyIntent | null;
}

const FALLBACK_STEPS: OnboardingStep[] = [
  { id: "explain", title: "What will change", state: "pending", detail: null, needsUser: true },
  { id: "apply", title: "Apply to this Mac", state: "pending", detail: null, needsUser: true },
  { id: "verify", title: "Verify", state: "pending", detail: null, needsUser: false },
  { id: "https", title: "HTTPS for the dashboard", state: "pending", detail: null, needsUser: true },
  { id: "mcp", title: "MCP server", state: "pending", detail: null, needsUser: true },
];

function normalizeOnboarding(body: Partial<OnboardingPayload>): OnboardingPayload {
  return {
    steps: body.steps?.length ? body.steps : FALLBACK_STEPS,
    complete: body.complete ?? false,
    skipped: body.skipped ?? false,
    changes: body.changes ?? [],
    command: body.command ?? null,
    verifyUrl: body.verifyUrl ?? null,
    mcpClients: body.mcpClients ?? [],
    sync: body.sync ?? NO_SYNC,
    intent: body.intent ?? null,
  };
}

export async function fetchOnboarding(): Promise<OnboardingPayload> {
  return normalizeOnboarding(await request<Partial<OnboardingPayload>>("/api/onboarding"));
}

export type OnboardingAction = OnboardingStepId | "skip" | "restart";

export async function runOnboarding(
  action: OnboardingAction,
  options: Record<string, unknown> = {},
): Promise<OnboardingPayload> {
  const body = await send<Partial<OnboardingPayload>>("/api/onboarding", "POST", {
    action,
    ...options,
  });
  return normalizeOnboarding(body);
}

// ---------------------------------------------------------------------------
// MCP (the settings drawer's section; the onboarding step writes the same files)
// ---------------------------------------------------------------------------

export interface McpClientState {
  id: string;
  name: string;
  configPath: string;
  /** The client's own config file exists. */
  installed: boolean;
  /** Our server is registered in it. */
  configured: boolean;
}

export interface McpState {
  clients: McpClientState[];
  /** Ready-to-paste TOML for users who would rather edit Codex's config themselves. */
  codexSnippet: string;
  configured: boolean;
}

function normalizeMcp(body: Partial<McpState>): McpState {
  const clients = body.clients ?? [];
  return {
    clients,
    codexSnippet: body.codexSnippet ?? "",
    configured: body.configured ?? clients.some((c) => c.configured),
  };
}

export async function fetchMcp(): Promise<McpState> {
  return normalizeMcp(await request<Partial<McpState>>("/api/mcp"));
}

export async function installMcp(client: string): Promise<McpState> {
  const body = await send<{ mcp?: Partial<McpState> }>("/api/mcp/install", "POST", { client });
  return normalizeMcp(body.mcp ?? {});
}

// ---------------------------------------------------------------------------
// Settings / system
// ---------------------------------------------------------------------------

export interface SettingsInput {
  tld?: string;
  dashboardPort?: number;
  https?: boolean;
  /** docs/AUTOAPPLY.md — when false the product behaves exactly as it did before. */
  autoApply?: boolean;
}

export interface SettingsResult {
  config: Config;
  sync: SyncReport;
  restartRequired: boolean;
}

export async function updateSettings(input: SettingsInput): Promise<SettingsResult> {
  return send<SettingsResult>("/api/settings", "PATCH", input);
}

export interface ApplyResult {
  ok: boolean;
  needsPrompt: boolean;
  system: SystemState;
  sync: SyncReport;
  intent: ApplyIntent;
}

/**
 * Refreshes the files the privileged script and the forwarder read, and reports what
 * still needs root. It does NOT raise the admin prompt: the dashboard is an
 * unprivileged process and stays one — the menu-bar app runs the command.
 */
export async function prepareApply(): Promise<ApplyResult> {
  return send<ApplyResult>("/api/apply", "POST");
}

// ---------------------------------------------------------------------------
// Privileged channel (dashboard asks, menu-bar app runs the one admin prompt)
//
//   POST /api/privileged/request   { kind }  -> { request, trayAlive }  | 409 when no tray
//   GET  /api/privileged/progress?id=…       -> PrivilegedProgress
// ---------------------------------------------------------------------------

export interface AskResult {
  request: PrivilegedRequest | null;
  trayAlive: boolean;
  /** The server's refusal, when the menu-bar app is not there to answer. */
  error: string | null;
}

/**
 * Ask for the privileged run. A refusal is a normal answer, not an exception: it means
 * the menu-bar app is not running, which the UI has to explain rather than throw about.
 */
export async function requestPrivileged(kind: PrivilegedKind = "apply"): Promise<AskResult> {
  try {
    const body = await send<{ request?: PrivilegedRequest; trayAlive?: boolean }>(
      "/api/privileged/request",
      "POST",
      { kind },
    );
    return { request: body.request ?? null, trayAlive: body.trayAlive ?? false, error: null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      return { request: null, trayAlive: false, error: err.message };
    }
    throw err;
  }
}

export async function fetchPrivilegedProgress(id?: string): Promise<PrivilegedProgress> {
  const query = id ? `?id=${encodeURIComponent(id)}` : "";
  const body = await request<Partial<PrivilegedProgress>>(`/api/privileged/progress${query}`);
  return {
    state: body.state ?? "idle",
    trayAlive: body.trayAlive ?? false,
    request: body.request ?? null,
    result: body.result ?? null,
  };
}
