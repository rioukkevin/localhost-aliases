/**
 * All of the dashboard's business logic, framework-free.
 *
 * The invariant every mutation here obeys:
 *
 *   1. persist the config through core's store   (the user's write must survive)
 *   2. rebuild the desired state and push it to the privileged helper
 *   3. return the fresh state, with a non-fatal `warning` when step 2 failed
 *
 * Step 2 never throws. The helper is optional infrastructure — it may not be
 * installed at all, which is the normal first-run state — so a failure there is
 * reported, not raised.
 */
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  buildApplyRequest,
  buildRoutes,
  claudeSnippet,
  codexSnippet,
  createAlias,
  deleteAlias,
  detectClients,
  helperApply,
  helperAvailability,
  helperInstallCommand,
  helperInstallMethod,
  helperStartCommand,
  helperStatus,
  installMcp,
  issueLeaf,
  loadConfig,
  mcpServerSpec,
  mergeWorkspaceAliases,
  normalizeName,
  probeAll,
  readWorkspace,
  toView,
  trustCommand,
  updateAlias,
  updateSettings,
  workspacePath,
  ValidationError,
  type Alias,
  type AliasStatus,
  type AliasView,
  type ApplyResponse,
  type Config,
  type CreateAliasInput,
  type HelperInstallMethod,
  type McpClientId,
  type McpClientState,
  type Project,
  type SystemStatus,
  type TrustStore,
  type UpdateAliasInput,
  type WorkspaceAliasEntry,
} from "@localhost-aliases/core";
import { getCerts } from "./certs.ts";
import { pushDesiredState } from "./desired-state.ts";
import { asNotFound, errorMessage } from "./errors.ts";
import type { SettingsPatch } from "./input.ts";
import { reconcileHelper } from "./reconcile.ts";
import { VERSION } from "./version.ts";

export type Settings = Omit<Config, "aliases">;

export interface Warned<T> {
  value: T;
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

async function viewsFor(config: Config): Promise<AliasView[]> {
  const statuses = await probeAll(config.aliases);
  return config.aliases.map((alias) => toView(alias, config, statuses.get(alias.id) ?? "unknown"));
}

export async function listAliasViews(): Promise<AliasView[]> {
  return viewsFor(await loadConfig());
}

export async function createAliasFlow(input: CreateAliasInput): Promise<Warned<AliasView>> {
  const { config, alias } = await createAlias(input);
  const warning = await pushDesiredState(config);
  return { value: await viewFor(alias, config), warning };
}

export async function updateAliasFlow(
  id: string,
  input: UpdateAliasInput,
): Promise<Warned<AliasView>> {
  let result: { config: Config; alias: Alias };
  try {
    result = await updateAlias(id, input);
  } catch (error) {
    throw asNotFound(error);
  }
  const warning = await pushDesiredState(result.config);
  return { value: await viewFor(result.alias, result.config), warning };
}

export async function deleteAliasFlow(id: string): Promise<Warned<AliasView>> {
  let result: { config: Config; alias: Alias };
  try {
    result = await deleteAlias(id);
  } catch (error) {
    throw asNotFound(error);
  }
  const warning = await pushDesiredState(result.config);
  // The deleted alias is no longer routable, so it is reported as down, not probed.
  return { value: toView(result.alias, result.config, "down"), warning };
}

async function viewFor(alias: Alias, config: Config): Promise<AliasView> {
  const statuses = await probeAll([alias]);
  return toView(alias, config, statuses.get(alias.id) ?? ("unknown" as AliasStatus));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsOf(config: Config): Settings {
  const { aliases: _aliases, ...settings } = config;
  return settings;
}

export async function getSettings(): Promise<Settings> {
  return settingsOf(await loadConfig());
}

export async function updateSettingsFlow(patch: SettingsPatch): Promise<Warned<Settings>> {
  const config = await updateSettings(patch);
  const warning = await pushDesiredState(config);
  return { value: settingsOf(config), warning };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyOutcome {
  applied: boolean;
  routes: number;
  response: ApplyResponse | null;
  warning: string | null;
}

/** Force a re-push of the current config; used by the "apply" button and after installs. */
export async function applyNow(): Promise<ApplyOutcome> {
  const config = await loadConfig();
  const routes = buildRoutes(config).length;

  let tls: { cert: string; key: string } | null = null;
  if (config.https) {
    try {
      tls = await issueLeaf(buildRoutes(config).map((route) => route.host));
    } catch (error) {
      return {
        applied: false,
        routes,
        response: null,
        warning: `The TLS certificate could not be issued: ${errorMessage(error)}`,
      };
    }
  }

  const result = await helperApply(buildApplyRequest(config, tls));
  if (!result.ok) {
    return {
      applied: false,
      routes,
      response: null,
      warning: `The privileged helper could not be updated: ${result.error}`,
    };
  }
  return { applied: true, routes, response: result.data, warning: null };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusPayload extends SystemStatus {
  /**
   * `installMethod` per docs/PHASE4.md §2: in a bundle only the tray can register the
   * daemon, so the dashboard must direct the user at the menu-bar icon and must never
   * print a sudo command.
   */
  helper: SystemStatus["helper"] & { installMethod: HelperInstallMethod };
  /** `trustedIn` says *which* keychain vouches for the CA, not merely that one does. */
  ca: SystemStatus["ca"] & { trustedIn: TrustStore[]; fingerprint: string | null };
  /**
   * What the padlock in the UI is allowed to claim. `coveredHosts` is the SAN list of the
   * leaf actually on disk: a hostname missing from it has no certificate yet, however
   * trusted the CA is.
   */
  tls: { enabled: boolean; listening: boolean; port: number; coveredHosts: string[] };
  /** Copy-pasteable commands for the UI's banners; not part of the frozen type. */
  commands: { install: string; start: string; trust: string; trustLogin: string };
}

export async function getStatus(): Promise<StatusPayload> {
  const config = await loadConfig();
  const availability = await helperAvailability();

  // Only ask for the detailed status when the helper actually answered, so the
  // "not installed" path costs one `existsSync` and no socket timeout.
  const status = availability.running ? await helperStatus() : null;
  let helper = status?.ok ? status.data : null;

  // Drift recovery rides this poll instead of owning a timer: a helper that
  // restarted under a running dashboard has an empty route table and nothing
  // else would ever notice. See lib/reconcile.ts.
  if ((await reconcileHelper(config, helper)).action === "repaired") {
    // Report the state we just restored, not the stale one we diagnosed from.
    const refreshed = await helperStatus();
    if (refreshed.ok) helper = refreshed.data;
  }

  // One read of the certificate world: trust state, fingerprint and what the leaf covers.
  const certs = await getCerts();
  const mcp = await detectClients();

  return {
    version: VERSION,
    tld: config.tld,
    dashboardPort: config.dashboardPort,
    https: config.https,
    aliasCount: config.aliases.length,
    helper: { ...availability, status: helper, installMethod: helperInstallMethod() },
    ca: {
      generated: certs.generated,
      trusted: certs.trusted,
      path: certs.path,
      trustedIn: certs.stores,
      fingerprint: certs.fingerprint,
    },
    tls: {
      enabled: config.https,
      listening: helper?.https.listening ?? false,
      port: helper?.https.port ?? config.httpsPort,
      coveredHosts: certs.coveredHosts,
    },
    mcp,
    commands: {
      install: helperInstallCommand(),
      start: helperStartCommand(),
      trust: trustCommand(),
      trustLogin: certs.commands.login,
    },
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** A malformed workspace file still counts as present — the UI should say so. */
async function hasWorkspaceFile(dir: string): Promise<boolean> {
  try {
    return (await readWorkspace(dir)) !== null;
  } catch {
    return true;
  }
}

function groupByProject(views: AliasView[]): Map<string, AliasView[]> {
  const groups = new Map<string, AliasView[]>();
  for (const view of views) {
    if (!view.projectPath) continue;
    const list = groups.get(view.projectPath) ?? [];
    list.push(view);
    groups.set(view.projectPath, list);
  }
  return groups;
}

export async function listProjects(): Promise<Project[]> {
  const config = await loadConfig();
  const views = await viewsFor(config);
  const groups = groupByProject(views);

  const projects = await Promise.all(
    [...groups.entries()].map(async ([path, aliases]) => ({
      path,
      name: basename(path) || path,
      hasWorkspaceFile: await hasWorkspaceFile(path),
      aliases,
    })),
  );
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

async function projectAt(path: string): Promise<Project> {
  const config = await loadConfig();
  const views = await viewsFor(config);
  return {
    path,
    name: basename(path) || path,
    hasWorkspaceFile: await hasWorkspaceFile(path),
    aliases: groupByProject(views).get(path) ?? [],
  };
}

/** Relative paths are refused outright: the server's cwd is not the caller's. */
async function assertDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new ValidationError([{ field: "path", message: "must be an absolute path" }]);
  }
  const info = await stat(path).catch(() => null);
  if (info === null) {
    throw new ValidationError([{ field: "path", message: `${path} does not exist` }]);
  }
  if (!info.isDirectory()) {
    throw new ValidationError([{ field: "path", message: `${path} is not a directory` }]);
  }
  return path;
}

export interface LinkOutcome {
  project: Project;
  workspacePath: string;
  created: string[];
  updated: string[];
}

/**
 * Links a folder: registers every entry as an alias (creating or re-pointing it)
 * and merges the workspace file. The workspace file is written last so a failed
 * alias registration does not leave a file describing aliases that do not exist.
 */
export async function linkProject(
  path: string,
  entries: WorkspaceAliasEntry[],
): Promise<Warned<LinkOutcome>> {
  const dir = await assertDirectory(path);
  const created: string[] = [];
  const updated: string[] = [];

  for (const entry of entries) {
    const name = normalizeName(entry.name);
    const current = (await loadConfig()).aliases.find((alias) => alias.name === name);
    if (current) {
      // Linking is an explicit user action, so it re-points an existing alias.
      await updateAlias(current.id, {
        port: entry.port,
        projectPath: dir,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      });
      updated.push(name);
    } else {
      await createAlias({
        name,
        port: entry.port,
        projectPath: dir,
        description: entry.description ?? null,
      });
      created.push(name);
    }
  }

  if (entries.length > 0) await mergeWorkspaceAliases(dir, entries);

  const config = await loadConfig();
  const warning = await pushDesiredState(config);
  return {
    value: {
      project: await projectAt(dir),
      workspacePath: workspacePath(dir),
      created,
      updated,
    },
    warning,
  };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export type McpSpec = ReturnType<typeof mcpServerSpec>;

export interface McpPayload {
  clients: { claude: McpClientState; codex: McpClientState };
  /** Empty strings only when the spec could not be resolved — see `reason`. */
  snippets: { claude: string; codex: string };
  spec: McpSpec | null;
  /** Non-null when one-click install cannot work; the UI should say so. */
  reason: string | null;
}

/**
 * Core owns the entrypoint resolution. It throws — with an actionable message —
 * when the MCP server is genuinely not on disk, which is the one case where the
 * UI must offer the copy-paste snippet instead of the install button.
 */
export async function getMcp(): Promise<McpPayload> {
  const clients = await detectClients();
  try {
    return {
      clients,
      snippets: { claude: claudeSnippet(), codex: codexSnippet() },
      spec: mcpServerSpec(),
      reason: null,
    };
  } catch (error) {
    return {
      clients,
      snippets: { claude: "", codex: "" },
      spec: null,
      reason: `One-click install is unavailable: ${errorMessage(error)}`,
    };
  }
}

export interface McpInstallOutcome {
  client: McpClientId;
  configPath: string;
  backupPath: string | null;
  snippet: string;
  clients: { claude: McpClientState; codex: McpClientState };
}

export async function installMcpClient(client: McpClientId): Promise<McpInstallOutcome> {
  // Core resolves the entrypoint and writes the file; an unresolvable entrypoint
  // throws here and surfaces as a 500 with core's actionable message, rather than
  // half-writing a config that points at a path that is not there.
  const result = await installMcp(client);
  return {
    client,
    configPath: result.configPath,
    backupPath: result.backupPath,
    snippet: result.snippet,
    clients: await detectClients(),
  };
}
