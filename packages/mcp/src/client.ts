/**
 * Thin HTTP client for the dashboard API.
 *
 * The MCP server owns no state: every tool is a call to the dashboard the tray already
 * runs. `fetch` is injectable so the tool handlers can be unit-tested without a socket.
 *
 * API contract consumed here (all JSON, all on 127.0.0.1):
 *   GET    /api/aliases        -> { aliases: AliasView[] }
 *   POST   /api/aliases        -> { alias: AliasView, sync: SyncReport }
 *   DELETE /api/aliases/:id    -> { deleted: string, sync: SyncReport }
 *   GET    /api/projects       -> { projects: Project[] }
 *   POST   /api/projects/link  -> { project, created, updated, workspaceFile, sync }
 * Errors are { error: string, issues?: ValidationIssue[] }.
 *
 * SyncReport is mirrored below rather than imported: the dashboard is a Next app and
 * nothing outside it should depend on its module graph.
 */
import type { AliasView, CreateAliasInput, Project } from "@localhost-aliases/core/types";
import { dashboardUrl } from "@localhost-aliases/core/paths";

/** The part of the dashboard's SyncReport this server acts on. */
export interface SyncReport {
  applied: boolean;
  needsPrompt: boolean;
  privileged: string[];
}

export interface AliasResult {
  alias: AliasView;
  sync?: SyncReport;
}

export interface DeleteResult {
  deleted: string;
  sync?: SyncReport;
}

export interface LinkProjectBody {
  path: string;
  aliasIds?: string[];
  /** Import the aliases the folder declares in .localhost-aliases.json. Default true. */
  importWorkspace?: boolean;
  writeWorkspaceFile?: boolean;
}

export interface LinkProjectResult {
  project: Project;
  created: AliasView[];
  updated: AliasView[];
  workspaceFile: string | null;
  sync?: SyncReport;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The dashboard is not answering. Always actionable, never a stack trace. */
export class DashboardUnreachableError extends Error {
  readonly baseUrl: string;
  constructor(baseUrl: string, cause: unknown) {
    super(
      [
        `The Localhost Aliases dashboard is not answering at ${baseUrl}.`,
        "",
        "The dashboard is embedded in the Localhost Aliases menu-bar app and only runs while",
        "that app is open. Ask the user to:",
        "  1. open Localhost Aliases from /Applications (or ~/Applications), or",
        "  2. run `bun run dev` in the localhost-aliases checkout for development.",
        "",
        "If the dashboard listens on another port, set LA_DASHBOARD_PORT for this MCP server.",
      ].join("\n"),
    );
    this.name = "DashboardUnreachableError";
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

/** The dashboard answered, but refused. Carries the message it gave. */
export class DashboardApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
  }
}

function pick<T>(body: unknown, key: string): T | undefined {
  if (body !== null && typeof body === "object" && key in (body as Record<string, unknown>)) {
    return (body as Record<string, T>)[key];
  }
  return undefined;
}

/** Dashboards may answer `{aliases: [...]}` or just `[...]`. Accept both. */
function unwrapList<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const nested = pick<T[]>(body, key);
  return Array.isArray(nested) ? nested : [];
}

function unwrapOne<T>(body: unknown, key: string): T {
  const nested = pick<T>(body, key);
  return (nested ?? body) as T;
}

/** Best-effort extraction of whatever the API called its error message. */
function errorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const issues = parsed.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((i) => {
          const issue = i as { field?: string; message?: string };
          return issue.field ? `${issue.field}: ${issue.message}` : String(issue.message ?? i);
        })
        .join("; ");
    }
    for (const key of ["error", "message", "detail"]) {
      const value = parsed[key];
      if (typeof value === "string" && value !== "") return value;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  const trimmed = text.trim();
  return trimmed === "" ? `HTTP ${status}` : `HTTP ${status}: ${trimmed.slice(0, 400)}`;
}

export interface DashboardClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class DashboardClient {
  readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: DashboardClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? dashboardUrl()).replace(/\/+$/, "");
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new DashboardUnreachableError(this.baseUrl, cause);
    }

    const text = await response.text();
    if (!response.ok) throw new DashboardApiError(response.status, errorMessage(response.status, text));
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new DashboardApiError(response.status, `${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  async listAliases(): Promise<AliasView[]> {
    return unwrapList<AliasView>(await this.request("GET", "/api/aliases"), "aliases");
  }

  async listProjects(): Promise<Project[]> {
    return unwrapList<Project>(await this.request("GET", "/api/projects"), "projects");
  }

  async createAlias(input: CreateAliasInput): Promise<AliasResult> {
    const body = await this.request("POST", "/api/aliases", input);
    return { alias: unwrapOne<AliasView>(body, "alias"), sync: pick<SyncReport>(body, "sync") };
  }

  async deleteAlias(id: string): Promise<DeleteResult> {
    const body = await this.request("DELETE", `/api/aliases/${encodeURIComponent(id)}`);
    return { deleted: pick<string>(body, "deleted") ?? id, sync: pick<SyncReport>(body, "sync") };
  }

  async linkProject(input: LinkProjectBody): Promise<LinkProjectResult> {
    return (await this.request("POST", "/api/projects/link", input)) as LinkProjectResult;
  }
}
