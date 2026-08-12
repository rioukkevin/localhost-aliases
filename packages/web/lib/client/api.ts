/**
 * Typed browser-side fetch layer. The only place in the client that knows URLs.
 *
 * Every call resolves to data or throws `ApiError`; nothing here swallows errors,
 * because the state hook needs the failure to roll an optimistic update back.
 */
import type {
  AliasView,
  Config,
  CreateAliasInput,
  McpClientId,
  McpClientState,
  Project,
  SystemStatus,
  UpdateAliasInput,
  ValidationIssue,
  WorkspaceAliasEntry,
} from "@localhost-aliases/core";
import { notifyServerStateChanged } from "./status-bus.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
      cache: "no-store",
    });
  } catch {
    // The dashboard process is gone or the browser is offline.
    throw new ApiError("Cannot reach the dashboard server.", 0);
  }

  // A route handler that crashes returns HTML, not JSON — do not blow up on parse.
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : `Request failed (${res.status})`;
    const issues =
      isRecord(body) && Array.isArray(body.issues) ? (body.issues as ValidationIssue[]) : [];
    throw new ApiError(message, res.status, issues);
  }

  // A successful write invalidates everything /api/status reports, so the shared
  // status store is told at once instead of finding out on its next tick.
  if (init?.method !== undefined && init.method !== "GET") notifyServerStateChanged();

  return body as T;
}

export async function fetchAliases(): Promise<AliasView[]> {
  const body = await request<{ aliases?: AliasView[] }>("/api/aliases");
  return Array.isArray(body?.aliases) ? body.aliases : [];
}

export async function fetchStatus(): Promise<SystemStatus> {
  return request<SystemStatus>("/api/status");
}

export async function createAlias(
  input: CreateAliasInput,
): Promise<{ alias: AliasView; warning?: string }> {
  return request("/api/aliases", { method: "POST", body: JSON.stringify(input) });
}

export async function updateAlias(
  id: string,
  patch: UpdateAliasInput,
): Promise<{ alias: AliasView; warning?: string }> {
  return request(`/api/aliases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAlias(id: string): Promise<void> {
  await request(`/api/aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Force the helper to reconcile the current desired state. */
export async function applyNow(): Promise<void> {
  await request("/api/apply", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function fetchProjects(): Promise<Project[]> {
  const body = await request<{ projects?: Project[] }>("/api/projects");
  return Array.isArray(body?.projects) ? body.projects : [];
}

export interface LinkProjectResult {
  project: Project;
  workspacePath: string;
  created: string[];
  updated: string[];
  warning?: string;
}

/** Registers the aliases for `path` and writes/merges its workspace file. */
export async function linkProject(
  path: string,
  aliases: WorkspaceAliasEntry[],
): Promise<LinkProjectResult> {
  return request("/api/projects/link", {
    method: "POST",
    body: JSON.stringify({ path, aliases }),
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type Settings = Omit<Config, "aliases">;

export async function fetchSettings(): Promise<Settings> {
  const body = await request<{ settings: Settings }>("/api/settings");
  return body.settings;
}

export async function patchSettings(
  patch: Partial<Settings>,
): Promise<{ settings: Settings; warning?: string }> {
  return request("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpPayload {
  clients: { claude: McpClientState; codex: McpClientState };
  /** Empty strings when `reason` is set — the server could not resolve the spec. */
  snippets: { claude: string; codex: string };
  spec: { command: string; args: string[]; env: Record<string, string> } | null;
  reason: string | null;
}

export interface McpInstallResult {
  client: McpClientId;
  configPath: string;
  /** null when there was no existing file to back up. */
  backupPath: string | null;
  snippet: string;
  clients: { claude: McpClientState; codex: McpClientState };
}

export async function fetchMcp(): Promise<McpPayload> {
  return request<McpPayload>("/api/mcp");
}

export async function installMcp(client: McpClientId): Promise<McpInstallResult> {
  return request("/api/mcp/install", { method: "POST", body: JSON.stringify({ client }) });
}

// ---------------------------------------------------------------------------
// Certificates and onboarding
// ---------------------------------------------------------------------------

export type TrustStore = "system" | "login";

export interface Certs {
  generated: boolean;
  path: string | null;
  trusted: boolean;
  stores: TrustStore[];
  fingerprint: string | null;
  loginKeychain: string;
  commands: { login: string; system: string };
  coveredHosts: string[];
  https: boolean;
  httpsPort: number;
}

export type VerifyOutcome =
  | "trusted"
  | "untrusted"
  | "foreign-certificate"
  | "unreachable"
  | "not-applicable";

export interface Verification {
  outcome: VerifyOutcome;
  url: string;
  hostname: string;
  port: number;
  httpStatus: number | null;
  detail: string;
  checkedAt: string;
}

export interface Onboarding {
  required: boolean;
  answered: boolean;
  completedAt: string | null;
  skippedAt: string | null;
  missing: { helper: boolean; ca: boolean };
  installMethod: "bundle" | "script";
}

export async function fetchCerts(): Promise<Certs> {
  return (await request<{ certs: Certs }>("/api/certs")).certs;
}

/** Idempotent: an existing CA is returned untouched. */
export async function generateCA(): Promise<{ created: boolean; certs: Certs }> {
  return request("/api/certs", { method: "POST" });
}

/**
 * Raises the macOS authentication dialog. Only ever called from a click — never from a
 * poll or an effect.
 */
export async function trustCA(): Promise<{
  ok: boolean;
  error: string | null;
  stubbed: boolean;
  certs: Certs;
}> {
  return request("/api/certs/trust", { method: "POST" });
}

export async function verifyHttps(hostname?: string): Promise<Verification> {
  const body = await request<{ verification: Verification }>("/api/certs/verify", {
    method: "POST",
    body: JSON.stringify(hostname ? { hostname } : {}),
  });
  return body.verification;
}

export async function fetchOnboarding(): Promise<Onboarding> {
  return (await request<{ onboarding: Onboarding }>("/api/onboarding")).onboarding;
}

export async function markOnboarding(
  action: "complete" | "skip" | "reset",
): Promise<Onboarding> {
  const body = await request<{ onboarding: Onboarding }>("/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  return body.onboarding;
}
