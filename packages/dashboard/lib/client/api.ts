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
 *   GET    /api/onboarding                                         -> OnboardingPayload
 *   POST   /api/onboarding             { action, ... }             -> OnboardingPayload
 *   PATCH  /api/settings               { tld?, dashboardPort?, https? } -> { config, restartRequired }
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

export async function fetchProjects(): Promise<Project[]> {
  const body = await request<{ projects?: Project[] }>("/api/projects");
  return body.projects ?? [];
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
