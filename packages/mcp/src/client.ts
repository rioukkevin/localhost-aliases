/**
 * HTTP layer: the only place that knows the dashboard REST API exists.
 *
 * Nothing here throws. Every call returns a discriminated `ApiResult` so the tool
 * layer can turn a dead dashboard into an actionable sentence instead of an
 * ECONNREFUSED stack trace, and a 400 into field-level issues.
 */
import { dashboardUrl } from "@localhost-aliases/core";
import type {
  AliasView,
  CreateAliasInput,
  Project,
  ValidationIssue,
} from "@localhost-aliases/core";

export type ApiFailure =
  /** The dashboard process is not answering (down, wrong port, or timed out). */
  | { ok: false; kind: "unreachable"; message: string; baseUrl: string }
  /** The API rejected the input; `issues` is field-level. */
  | { ok: false; kind: "validation"; message: string; status: number; issues: ValidationIssue[] }
  /** Any other non-2xx response. */
  | { ok: false; kind: "http"; message: string; status: number };

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/** Generous: the aliases endpoint probes every upstream port before answering. */
const TIMEOUT_MS = 10_000;

/** Read lazily so LA_DASHBOARD_PORT is honoured whenever it is set. */
export function baseUrl(): string {
  return dashboardUrl();
}

export function unreachableMessage(url: string, detail: string): string {
  return [
    `The localhost-aliases dashboard is not reachable at ${url} (${detail}).`,
    "That app owns the alias config and the connection to the privileged helper, so no alias can be read or changed until it is running.",
    "To start it: open the localhost-aliases menu-bar app, or run `bun run dev` in the localhost-aliases repo,",
    "or `launchctl kickstart -k gui/$(id -u)/dev.localhost-aliases.web` if it was installed with scripts/install.sh.",
    "If it is running on a different port, set LA_DASHBOARD_PORT for this MCP server to match.",
  ].join(" ");
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // Bun surfaces the useful part on `cause` for connection failures.
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    if (err.name === "TimeoutError" || err.name === "AbortError") return `no response within ${TIMEOUT_MS}ms`;
    return causeMessage ? `${err.message}: ${causeMessage}` : err.message;
  }
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issuesOf(body: unknown): ValidationIssue[] {
  if (!isRecord(body) || !Array.isArray(body.issues)) return [];
  return body.issues.filter(
    (i): i is ValidationIssue =>
      isRecord(i) && typeof i.field === "string" && typeof i.message === "string",
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: "unreachable", message: unreachableMessage(baseUrl(), describe(err)), baseUrl: baseUrl() };
  }

  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const issues = issuesOf(body);
    const message =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status} ${response.statusText}`.trim();
    if (response.status === 400 || issues.length > 0) {
      return { ok: false, kind: "validation", message, status: response.status, issues };
    }
    return { ok: false, kind: "http", message, status: response.status };
  }

  return { ok: true, data: body as T };
}

function unwrap<T, K extends string>(result: ApiResult<Record<K, T[]>>, key: K): ApiResult<T[]> {
  if (!result.ok) return result;
  const list = result.data?.[key];
  return { ok: true, data: Array.isArray(list) ? list : [] };
}

// ---------------------------------------------------------------------------
// Endpoints (docs/ARCHITECTURE.md -> packages/web)
// ---------------------------------------------------------------------------

export async function fetchAliases(): Promise<ApiResult<AliasView[]>> {
  return unwrap(await request<{ aliases: AliasView[] }>("/api/aliases"), "aliases");
}

export async function fetchProjects(): Promise<ApiResult<Project[]>> {
  return unwrap(await request<{ projects: Project[] }>("/api/projects"), "projects");
}

export async function postAlias(
  input: CreateAliasInput,
): Promise<ApiResult<{ alias: AliasView; warning?: string }>> {
  return request("/api/aliases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteAliasById(
  id: string,
): Promise<ApiResult<{ alias?: AliasView; warning?: string }>> {
  return request(`/api/aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
}
