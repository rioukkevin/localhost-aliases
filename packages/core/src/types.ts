/**
 * Shared contract for every process in the system.
 * This file is the single source of truth: helper, web, mcp and tests all import it.
 * Treat it as frozen unless the change is coordinated across all packages.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** A single name -> port mapping. `name` is the host label only, without the TLD. */
export interface Alias {
  id: string;
  /** Host label, e.g. "myapp" or "api.myapp". Lowercase, no leading/trailing dot. */
  name: string;
  /** Local port the traffic is forwarded to. 1-65535. */
  port: number;
  /** Forward target host. Defaults to "127.0.0.1". */
  target: string;
  /** Absolute path of the project folder this alias belongs to, if any. */
  projectPath: string | null;
  /** Free-form human label shown in the dashboard. */
  description: string | null;
  /** Disabled aliases keep their config but are not routed nor written to /etc/hosts. */
  enabled: boolean;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** Persisted user configuration. Lives at `configPath()`. */
export interface Config {
  version: 1;
  /** TLD appended to every alias name, without the dot. Default "local". */
  tld: string;
  /** Port the privileged helper listens on for plain HTTP. Default 80. */
  httpPort: number;
  /** Port the privileged helper listens on for TLS. Default 443. */
  httpsPort: number;
  /** Port the Next.js dashboard/API binds on 127.0.0.1. Default 7788. */
  dashboardPort: number;
  /** When true, the local CA is used to serve HTTPS for every alias. */
  https: boolean;
  aliases: Alias[];
}

export const DEFAULT_CONFIG: Omit<Config, "aliases"> = {
  version: 1,
  tld: "local",
  httpPort: 80,
  httpsPort: 443,
  dashboardPort: 7788,
  // HTTPS by default since Phase 4: a new install serves TLS from its own local CA.
  // Only *new* configs get this — store.ts keeps whatever an existing file already says.
  https: true,
};

/** Reserved names that must never be registered (would shadow system resolution). */
export const RESERVED_NAMES = ["localhost", "broadcasthost", "local"] as const;

/** Input accepted by the create endpoint. */
export interface CreateAliasInput {
  name: string;
  port: number;
  target?: string;
  projectPath?: string | null;
  description?: string | null;
  enabled?: boolean;
}

/** Input accepted by the update endpoint. All fields optional. */
export type UpdateAliasInput = Partial<CreateAliasInput>;

/** Liveness of the upstream port behind an alias. */
export type AliasStatus = "up" | "down" | "unknown";

/** An Alias enriched for presentation. Returned by the web API, never persisted. */
export interface AliasView extends Alias {
  /** Fully-qualified hostname, e.g. "myapp.local". */
  hostname: string;
  /** Primary browser URL, e.g. "http://myapp.local" (https when enabled). */
  url: string;
  status: AliasStatus;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Privileged helper protocol (HTTP over unix socket)
// ---------------------------------------------------------------------------

/** One routing rule handed to the privileged helper. */
export interface Route {
  /** Fully-qualified hostname to match on the Host header, e.g. "myapp.local". */
  host: string;
  /** Upstream host, e.g. "127.0.0.1". */
  target: string;
  /** Upstream port. */
  port: number;
  /** Alias id, echoed back in helper logs/status for traceability. */
  aliasId: string;
}

/** Full desired state pushed to the helper. The helper is otherwise stateless. */
export interface ApplyRequest {
  httpPort: number;
  httpsPort: number;
  routes: Route[];
  /** When present the helper (re)binds a TLS listener with this material. */
  tls: { cert: string; key: string } | null;
}

export interface ApplyResponse {
  ok: true;
  /** True when /etc/hosts content actually changed on disk. */
  hostsChanged: boolean;
  /** True when the DNS cache was flushed as a result. */
  dnsFlushed: boolean;
  routes: number;
}

export interface HelperStatus {
  ok: true;
  version: string;
  /** Seconds since the helper started. */
  uptime: number;
  http: { listening: boolean; port: number };
  https: { listening: boolean; port: number };
  routes: number;
  /** Hostnames currently present in the managed /etc/hosts block. */
  managedHosts: string[];
}

export interface HelperError {
  ok: false;
  error: string;
}

/** Reported by the web layer when the helper cannot be reached. */
export interface HelperUnavailable {
  installed: boolean;
  running: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// System status (web API -> dashboard / MCP)
// ---------------------------------------------------------------------------

export interface SystemStatus {
  version: string;
  tld: string;
  dashboardPort: number;
  https: boolean;
  aliasCount: number;
  helper: HelperUnavailable & { status: HelperStatus | null };
  ca: { generated: boolean; trusted: boolean; path: string | null };
  mcp: { claude: McpClientState; codex: McpClientState };
}

export interface McpClientState {
  /** Config file exists and contains our server entry. */
  installed: boolean;
  /** Absolute path of the client config file we would write. */
  configPath: string;
  /** True when the client's config file exists at all. */
  clientDetected: boolean;
}

export type McpClientId = "claude" | "codex";

// ---------------------------------------------------------------------------
// Project workspace file (.localhost-aliases.json in a project root)
// ---------------------------------------------------------------------------

export interface WorkspaceAliasEntry {
  name: string;
  port: number;
  description?: string;
}

export interface WorkspaceFile {
  $schema?: string;
  aliases: WorkspaceAliasEntry[];
}

/** A project = a folder with at least one alias attached, or a workspace file. */
export interface Project {
  /** Absolute folder path. */
  path: string;
  /** Basename of the folder, used as display name. */
  name: string;
  /** Whether a .localhost-aliases.json exists in that folder. */
  hasWorkspaceFile: boolean;
  aliases: AliasView[];
}

export const WORKSPACE_FILENAME = ".localhost-aliases.json";

// ---------------------------------------------------------------------------
// /etc/hosts managed block markers. Never change these: uninstall depends on them.
// ---------------------------------------------------------------------------

export const HOSTS_BEGIN = "# >>> localhost-aliases >>>";
export const HOSTS_END = "# <<< localhost-aliases <<<";
