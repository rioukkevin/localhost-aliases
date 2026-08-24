/**
 * v2 shared contract. Every package imports from here; treat it as frozen.
 *
 * v2 has no HTTP proxy. Each alias gets its own loopback IP, and a root TCP forwarder
 * splices <ip>:80 to 127.0.0.1:<port>. Nothing parses HTTP, so WebSockets and any other
 * protocol pass through untouched — and we cannot terminate TLS for project aliases.
 */
import { DEFAULT_TLD } from "./tld.ts";

/** Which suffixes an alias may end in, and why the broken ones are refused. */
export * from "./tld.ts";

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface Alias {
  id: string;
  /** Host label without the TLD, e.g. "myapp". Lowercase. */
  name: string;
  /** Port the dev server listens on, on 127.0.0.1. */
  port: number;
  /** Loopback IP owned by this alias for life, e.g. "127.0.0.2". */
  ip: string;
  /** Absolute project folder path, or null. Optional by design. */
  projectPath: string | null;
  description: string | null;
  enabled: boolean;
  /** True only for the built-in dashboard alias; it cannot be renamed or deleted. */
  reserved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Config {
  version: 2;
  /** TLD appended to every alias name, without the dot. See tld.ts for what is refused. */
  tld: string;
  /** Port the embedded dashboard binds on 127.0.0.1. */
  dashboardPort: number;
  /** TLS for the dashboard only. Project aliases can never be https in v2. */
  https: boolean;
  /**
   * Apply automatically after a mutation that needs root, so adding an alias raises the
   * one admin prompt without a second click. Default true; a config written before this
   * field existed reads as true, because a MISSING field is not `false`.
   *
   * When false the product behaves exactly as it did before: the desired state is written
   * and the user clicks "Prepare and apply" themselves.
   */
  autoApply: boolean;
  aliases: Alias[];
}

export const DEFAULT_CONFIG: Omit<Config, "aliases"> = {
  version: 2,
  tld: DEFAULT_TLD,
  dashboardPort: 7788,
  https: false,
  autoApply: true,
};

/** The built-in alias that serves the dashboard itself. */
export const RESERVED_ALIAS_NAME = "index";
/** Names a user may never register. */
export const RESERVED_NAMES = ["localhost", "broadcasthost", "local"] as const;

/** Loopback pool. 127.0.0.1 is the real loopback and is never allocated. */
export const IP_POOL_START = 2;
export const IP_POOL_END = 254;
export const IP_PREFIX = "127.0.0.";

export type AliasStatus = "up" | "down" | "unknown";

/** An Alias enriched for display. Never persisted. */
export interface AliasView extends Alias {
  /** e.g. "myapp.test" */
  hostname: string;
  /** e.g. "http://myapp.test" */
  url: string;
  status: AliasStatus;
}

export interface CreateAliasInput {
  name: string;
  port: number;
  projectPath?: string | null;
  description?: string | null;
  enabled?: boolean;
}
export type UpdateAliasInput = Partial<CreateAliasInput>;

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
// Desired state — what the privileged apply and the forwarder consume
// ---------------------------------------------------------------------------

/** One forwarding rule. The forwarder binds `ip:listenPort` and splices to 127.0.0.1:targetPort. */
export interface Route {
  /** Loopback IP to bind, e.g. "127.0.0.2". */
  ip: string;
  /** Always 80 today; kept explicit so 443 can be added without a format change. */
  listenPort: number;
  /** Destination port on 127.0.0.1. */
  targetPort: number;
  /** For logging and the forwarder's status output only. */
  hostname: string;
  /**
   * How to start this project on `targetPort`, from packages/core/src/stack.ts. Optional and
   * purely advisory: the offline page prints it when the upstream is not listening, so the
   * root agent never has to read the user's project folders itself. Whoever writes the desired
   * state fills it in; nothing depends on it being present or being right.
   */
  hint?: { framework: string; command: string };
}

/** Written by the dashboard, read by the privileged apply script. */
export interface DesiredState {
  /** Managed /etc/hosts entries, in file order. */
  hosts: Array<{ ip: string; hostname: string }>;
  /** Loopback IPs that must exist on lo0. */
  loopbackIps: string[];
  /** Routes handed to the forwarder. */
  routes: Route[];
}

/** What the forwarder writes so the UI can show real state without root. */
export interface ForwarderStatus {
  pid: number;
  startedAt: string;
  routes: Route[];
  /** Routes it could not bind, with the reason. */
  failures: Array<{ route: Route; error: string }>;
}

/** Live system state, as observed without privileges. */
export interface SystemState {
  /** Loopback IPs currently present on lo0. */
  loopbackIps: string[];
  /** Hostnames currently in the managed /etc/hosts block. */
  managedHosts: string[];
  /** Whether the forwarder is running and current. */
  forwarder: ForwarderStatus | null;
  /** True when live state matches desired state and no admin prompt is needed. */
  applied: boolean;
  /** Human-readable reasons the state has drifted. Empty when applied. */
  drift: string[];
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export type OnboardingStepId = "explain" | "apply" | "verify" | "https" | "mcp";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  detail: string | null;
  /** True when this step cannot be automated and needs the user to click. */
  needsUser: boolean;
}

// ---------------------------------------------------------------------------
// Project workspace file (optional, project-local)
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
export const WORKSPACE_FILENAME = ".localhost-aliases.json";

export interface Project {
  path: string;
  name: string;
  hasWorkspaceFile: boolean;
  aliases: AliasView[];
}

// ---------------------------------------------------------------------------
// /etc/hosts markers. Never change these: uninstall depends on them.
// ---------------------------------------------------------------------------

export const HOSTS_BEGIN = "# >>> localhost-aliases >>>";
export const HOSTS_END = "# <<< localhost-aliases <<<";

// ---------------------------------------------------------------------------
// Dashboard -> tray request channel (see paths.applyRequestPath)
// ---------------------------------------------------------------------------

export type PrivilegedKind = "apply" | "uninstall";

/** Written by the dashboard when the user clicks. The tray is the only reader. */
export interface PrivilegedRequest {
  id: string;
  kind: PrivilegedKind;
  requestedAt: string;
}

/** Written by the tray once the admin prompt has been answered, one per request id. */
export interface PrivilegedResult {
  id: string;
  kind: PrivilegedKind;
  ok: boolean;
  /** True when the user dismissed the macOS password dialog. Not an error. */
  cancelled: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

/** What the dashboard shows while it waits. */
export interface PrivilegedProgress {
  state: "idle" | "pending" | "done";
  /** False when the menu-bar app is not running, so nothing will ever pick the request up. */
  trayAlive: boolean;
  request: PrivilegedRequest | null;
  result: PrivilegedResult | null;
}
