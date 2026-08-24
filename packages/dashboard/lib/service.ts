/**
 * All dashboard business logic. Framework-free: no Request, no Response, no Next import,
 * so it can be unit-tested directly and reused by anything else that needs it.
 *
 * Every mutation follows the same sequence:
 *   mutate config -> buildDesiredState -> write desired-state.json + routes.json
 *                 -> observe the live machine -> diff -> report whether a prompt is needed.
 *
 * It NEVER runs a privileged command. When root work is required it returns an
 * ApplyIntent describing exactly what the tray (or the user) must execute.
 */
import { stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import {
  POOL_SIZE,
  RESERVED_ALIAS_NAME,
  ValidationError,
  buildDesiredState,
  configDir,
  createAlias,
  deleteAlias,
  detectClients,
  getAlias,
  hostnameFor,
  installMcp,
  loadConfig,
  mcpServerSpec,
  codexSnippet,
  desiredStatePath,
  probeAll,
  readWorkspace,
  routesPath,
  runtimeLayout,
  targetPortFor,
  toView,
  updateAlias,
  updateSettings,
  mergeWorkspace,
  workspacePath,
  writeWorkspace,
  type Alias,
  type AliasView,
  type Config,
  type CreateAliasInput,
  type DesiredState,
  type McpClient,
  type McpClientId,
  type McpServerSpec,
  type Project,
  type StateDiff,
  type SystemState,
  type UpdateAliasInput,
  type WorkspaceAliasEntry,
} from "@localhost-aliases/core";
import { autoApplyScheduler } from "./auto-apply-runtime.ts";
import { NotFoundError, invalid } from "./http.ts";
import { writeRuntimeFiles } from "./runtime-files.ts";
import { readSystemState, type SystemProbes } from "./system.ts";
import type { AutoApply, AutoApplyStatus } from "./auto-apply.ts";

export const APP_VERSION = "2.0.0";

/**
 * What must happen under the single admin prompt. Produced here, executed elsewhere:
 * the dashboard is an unprivileged process and stays one.
 */
export interface ApplyIntent {
  required: boolean;
  /** Reasons only root can resolve. Shown to the user before they are prompted. */
  reasons: string[];
  /** The one privileged entrypoint, and the file it consumes. */
  script: string;
  desiredStatePath: string;
  routesPath: string;
  /** Exactly what the tray runs behind `osascript ... with administrator privileges`. */
  command: string[];
}

export interface SyncReport {
  applied: boolean;
  needsPrompt: boolean;
  drift: string[];
  privileged: string[];
  /** Drift the running forwarder fixes on its own once routes.json changes. */
  unprivileged: string[];
  intent: ApplyIntent;
}

export interface StateSnapshot {
  config: Config;
  desired: DesiredState;
  system: SystemState;
  sync: SyncReport;
  /** Dashboard's own hostname, e.g. "index.test". */
  dashboardHostname: string;
  capacity: { used: number; total: number; remaining: number };
  /** Raw bytes are forwarded, so TLS can never be terminated for project aliases. */
  httpsSupportedForAliases: false;
  configDir: string;
  /** Where automatic apply stands, so the UI can be honest instead of guessing. */
  autoApply: AutoApplyStatus;
}

export interface ServiceOptions {
  probes?: SystemProbes;
  /** Skip liveness probing where the caller does not need statuses. */
  probeStatuses?: boolean;
  probeTimeoutMs?: number;
  /** The auto-apply state machine. Defaults to the one process-wide scheduler. */
  scheduler?: AutoApply;
  /**
   * False when this mutation was NOT something a user just did — startup reconciliation
   * is the only such caller today. Only a user-initiated mutation may ever lead to an
   * admin prompt, so this flag is the switch that keeps startup drift silent.
   */
  userInitiated?: boolean;
}

function schedulerFor(options: ServiceOptions): AutoApply {
  return options.scheduler ?? autoApplyScheduler();
}

/**
 * The one place a mutation can turn into an automatic admin prompt.
 *
 * `report.needsPrompt` is `diffDesiredState`'s verdict, reused rather than reimplemented:
 * a port-only change leaves it false, and writing routes.json has already made that change
 * live. Everything else about the decision — coalescing, the tray heartbeat, never looping
 * on cancel — belongs to the scheduler.
 */
async function afterMutation(
  config: Config,
  report: SyncReport,
  options: ServiceOptions,
): Promise<AutoApplyStatus> {
  const scheduler = schedulerFor(options);
  scheduler.setEnabled(config.autoApply);
  if (options.userInitiated === false) return scheduler.snapshot();
  return scheduler.notifyMutation({ needsRoot: report.needsPrompt });
}

// --- desired state ----------------------------------------------------------

function intentFrom(diff: StateDiff): ApplyIntent {
  const layout = runtimeLayout();
  return {
    required: diff.needsPrompt,
    reasons: diff.privileged,
    script: layout.applyScript,
    desiredStatePath: desiredStatePath(),
    routesPath: routesPath(),
    command: [layout.applyScript, desiredStatePath()],
  };
}

function reportFrom(diff: StateDiff): SyncReport {
  return {
    applied: diff.applied,
    needsPrompt: diff.needsPrompt,
    drift: diff.drift,
    privileged: diff.privileged,
    unprivileged: diff.unprivileged,
    intent: intentFrom(diff),
  };
}

export { writeRuntimeFiles };

/** The core sequence, shared by every mutation and by GET /api/state. */
export async function sync(options: ServiceOptions = {}): Promise<{
  config: Config;
  desired: DesiredState;
  system: SystemState;
  report: SyncReport;
}> {
  const config = await loadConfig();
  const desired = buildDesiredState(config);
  await writeRuntimeFiles(desired);
  const live = await readSystemState(desired, options.probes);
  return { config, desired, system: live.system, report: reportFrom(live.diff) };
}

export async function getState(options: ServiceOptions = {}): Promise<StateSnapshot> {
  const { config, desired, system, report } = await sync(options);
  // A poll settles an in-flight run and reports where things stand. It can never queue:
  // status() has no path to the request file.
  const scheduler = schedulerFor(options);
  scheduler.setEnabled(config.autoApply);
  const autoApply = await scheduler.status();
  return {
    config,
    desired,
    system,
    sync: report,
    dashboardHostname: hostnameFor(RESERVED_ALIAS_NAME, config.tld),
    capacity: {
      used: config.aliases.length,
      total: POOL_SIZE,
      remaining: Math.max(0, POOL_SIZE - config.aliases.length),
    },
    httpsSupportedForAliases: false,
    configDir: configDir(),
    autoApply,
  };
}

// --- aliases ----------------------------------------------------------------

async function viewsFor(
  aliases: readonly Alias[],
  config: Config,
  options: ServiceOptions,
): Promise<AliasView[]> {
  if (options.probeStatuses === false) return aliases.map((a) => toView(a, config));
  const statuses = await probeAll(
    aliases.map((a) => ({ id: a.id, port: targetPortFor(a, config) })),
    options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs },
  );
  return aliases.map((a) => toView(a, config, statuses[a.id] ?? "unknown"));
}

export async function listAliases(options: ServiceOptions = {}): Promise<AliasView[]> {
  const config = await loadConfig();
  return viewsFor(config.aliases, config, options);
}

export async function getAliasView(id: string, options: ServiceOptions = {}): Promise<AliasView> {
  const config = await loadConfig();
  const alias = config.aliases.find((a) => a.id === id);
  if (!alias) throw new NotFoundError(`No alias with id "${id}".`);
  const [view] = await viewsFor([alias], config, options);
  return view!;
}

export interface AliasResult {
  alias: AliasView;
  sync: SyncReport;
  /** What the automatic apply did about this mutation, if anything. */
  autoApply: AutoApplyStatus;
}

/** JSON bodies arrive untyped; ports from HTML forms arrive as strings. */
function toCreateInput(body: Record<string, unknown>): CreateAliasInput {
  return {
    name: typeof body.name === "string" ? body.name : (body.name as string),
    port: typeof body.port === "string" ? Number(body.port) : (body.port as number),
    ...(body.projectPath !== undefined ? { projectPath: body.projectPath as string | null } : {}),
    ...(body.description !== undefined ? { description: body.description as string | null } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
  };
}

function toUpdateInput(body: Record<string, unknown>): UpdateAliasInput {
  const input: UpdateAliasInput = {};
  if (body.name !== undefined) input.name = body.name as string;
  if (body.port !== undefined) input.port = typeof body.port === "string" ? Number(body.port) : (body.port as number);
  if (body.projectPath !== undefined) input.projectPath = body.projectPath as string | null;
  if (body.description !== undefined) input.description = body.description as string | null;
  if (body.enabled !== undefined) input.enabled = Boolean(body.enabled);
  return input;
}

export async function createAliasAndSync(
  body: Record<string, unknown>,
  options: ServiceOptions = {},
): Promise<AliasResult> {
  const config = await loadConfig();
  if (config.aliases.length >= POOL_SIZE) {
    throw invalid(
      "name",
      `All ${POOL_SIZE} loopback addresses are in use. Delete an alias before adding another.`,
    );
  }
  // The alias is persisted here, BEFORE anything privileged is even considered. A prompt
  // the user dismisses, or one that fails, can therefore never lose it.
  const alias = await createAlias(toCreateInput(body));
  const { config: next, report } = await sync(options);
  const [view] = await viewsFor([alias], next, options);
  return { alias: view!, sync: report, autoApply: await afterMutation(next, report, options) };
}

export async function updateAliasAndSync(
  id: string,
  body: Record<string, unknown>,
  options: ServiceOptions = {},
): Promise<AliasResult> {
  if ((await getAlias(id)) === null) throw new NotFoundError(`No alias with id "${id}".`);
  const alias = await updateAlias(id, toUpdateInput(body));
  const { config, report } = await sync(options);
  const [view] = await viewsFor([alias], config, options);
  return { alias: view!, sync: report, autoApply: await afterMutation(config, report, options) };
}

export async function deleteAliasAndSync(
  id: string,
  options: ServiceOptions = {},
): Promise<{ deleted: string; sync: SyncReport; autoApply: AutoApplyStatus }> {
  if ((await getAlias(id)) === null) throw new NotFoundError(`No alias with id "${id}".`);
  await deleteAlias(id);
  const { config, report } = await sync(options);
  return { deleted: id, sync: report, autoApply: await afterMutation(config, report, options) };
}

// --- settings ---------------------------------------------------------------

export interface SettingsResult {
  config: Config;
  sync: SyncReport;
  /** The dashboard binds its port at boot; moving it needs a restart of the app. */
  restartRequired: boolean;
  autoApply: AutoApplyStatus;
}

export async function getSettings(options: ServiceOptions = {}): Promise<SettingsResult> {
  const { config, report } = await sync(options);
  const scheduler = schedulerFor(options);
  scheduler.setEnabled(config.autoApply);
  return { config, sync: report, restartRequired: false, autoApply: await scheduler.status() };
}

export async function updateSettingsAndSync(
  body: Record<string, unknown>,
  options: ServiceOptions = {},
): Promise<SettingsResult> {
  const before = await loadConfig();
  const patch: Parameters<typeof updateSettings>[0] = {};
  if (body.tld !== undefined) patch.tld = body.tld as string;
  if (body.dashboardPort !== undefined) {
    patch.dashboardPort =
      typeof body.dashboardPort === "string" ? Number(body.dashboardPort) : (body.dashboardPort as number);
  }
  if (body.https !== undefined) patch.https = body.https as boolean;
  if (body.autoApply !== undefined) patch.autoApply = body.autoApply as boolean;
  if (Object.keys(patch).length === 0) {
    throw invalid("body", "Nothing to update. Send tld, dashboardPort, https or autoApply.");
  }

  const config = await updateSettings(patch);
  const { report } = await sync(options);
  return {
    config,
    sync: report,
    restartRequired: config.dashboardPort !== before.dashboardPort,
    autoApply: await afterMutation(config, report, options),
  };
}

// --- projects ---------------------------------------------------------------

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hasWorkspaceFile(dir: string): Promise<boolean> {
  try {
    return (await stat(workspacePath(dir))).isFile();
  } catch {
    return false;
  }
}

export async function listProjects(options: ServiceOptions = {}): Promise<Project[]> {
  const config = await loadConfig();
  const linked = config.aliases.filter((a) => typeof a.projectPath === "string" && a.projectPath !== "");
  const views = await viewsFor(linked, config, options);

  const byPath = new Map<string, AliasView[]>();
  for (const view of views) {
    const path = view.projectPath as string;
    const list = byPath.get(path);
    if (list) list.push(view);
    else byPath.set(path, [view]);
  }

  return Promise.all(
    [...byPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, aliases]) => ({
        path,
        name: basename(path) || path,
        hasWorkspaceFile: await hasWorkspaceFile(path),
        aliases,
      })),
  );
}

export interface LinkProjectResult {
  project: Project;
  created: AliasView[];
  updated: AliasView[];
  /** Path of the workspace file written, when the caller asked for one. */
  workspaceFile: string | null;
  sync: SyncReport;
  autoApply: AutoApplyStatus;
}

/**
 * Attach a folder to aliases, and optionally import the aliases the folder itself
 * declares in .localhost-aliases.json. Importing is what makes `git clone && open the
 * app` work; it is on by default and is a no-op when there is no workspace file.
 */
export async function linkProject(
  body: Record<string, unknown>,
  options: ServiceOptions = {},
): Promise<LinkProjectResult> {
  const rawPath = typeof body.path === "string" ? body.path.trim() : "";
  if (rawPath === "") throw invalid("path", "A project folder path is required.");
  if (!isAbsolute(rawPath)) throw invalid("path", "The project path must be absolute.");
  const path = normalize(rawPath).replace(/\/+$/, "") || "/";
  if (!(await isDirectory(path))) throw invalid("path", `"${path}" is not a folder on this Mac.`);

  const aliasIds = Array.isArray(body.aliasIds) ? body.aliasIds.filter((v): v is string => typeof v === "string") : [];
  const importWorkspace = body.importWorkspace !== false;
  const shouldWriteWorkspace = body.writeWorkspaceFile === true;

  const createdIds: string[] = [];
  const updatedIds: string[] = [];

  for (const id of aliasIds) {
    const alias = await getAlias(id);
    if (!alias) throw new NotFoundError(`No alias with id "${id}".`);
    if (alias.reserved) throw invalid("aliasIds", "The dashboard alias cannot be linked to a project.");
    await updateAlias(id, { projectPath: path });
    updatedIds.push(id);
  }

  if (importWorkspace) {
    // A broken workspace file throws out of readWorkspace: better than silently
    // dropping aliases the user committed to their repo.
    const workspace = await readWorkspace(path);
    for (const entry of workspace?.aliases ?? []) {
      const config = await loadConfig();
      const existing = config.aliases.find((a) => a.name === entry.name);
      if (existing) {
        if (existing.reserved) continue;
        await updateAlias(existing.id, { port: entry.port, projectPath: path });
        if (!updatedIds.includes(existing.id)) updatedIds.push(existing.id);
      } else {
        const alias = await createAlias({
          name: entry.name,
          port: entry.port,
          projectPath: path,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        });
        createdIds.push(alias.id);
      }
    }
  }

  let workspaceFile: string | null = null;
  if (shouldWriteWorkspace) {
    const config = await loadConfig();
    const entries: WorkspaceAliasEntry[] = config.aliases
      .filter((a) => a.projectPath === path && !a.reserved)
      .map((a) => ({
        name: a.name,
        port: a.port,
        ...(a.description ? { description: a.description } : {}),
      }));
    workspaceFile = await writeWorkspace(path, mergeWorkspace(await readWorkspace(path), entries));
  }

  const { config, report } = await sync(options);
  const all = await viewsFor(
    config.aliases.filter((a) => a.projectPath === path),
    config,
    options,
  );

  return {
    project: {
      path,
      name: basename(path) || path,
      hasWorkspaceFile: await hasWorkspaceFile(path),
      aliases: all,
    },
    created: all.filter((a) => createdIds.includes(a.id)),
    updated: all.filter((a) => updatedIds.includes(a.id)),
    workspaceFile,
    sync: report,
    autoApply: await afterMutation(config, report, options),
  };
}

// --- MCP --------------------------------------------------------------------

export interface McpState {
  clients: McpClient[];
  spec: McpServerSpec;
  /** Ready-to-paste TOML, for users who would rather edit Codex's config themselves. */
  codexSnippet: string;
  configured: boolean;
}

export async function getMcpState(): Promise<McpState> {
  const config = await loadConfig();
  const spec = mcpServerSpec(config.dashboardPort);
  const clients = await detectClients();
  return {
    clients,
    spec,
    codexSnippet: codexSnippet(spec),
    configured: clients.some((c) => c.configured),
  };
}

function toClientId(value: unknown): McpClientId {
  if (value === "claude" || value === "codex") return value;
  throw invalid("client", 'client must be "claude" or "codex".');
}

export async function installMcpClient(body: Record<string, unknown>): Promise<{
  installed: Awaited<ReturnType<typeof installMcp>>;
  mcp: McpState;
}> {
  const client = toClientId(body.client);
  const config = await loadConfig();
  const installed = await installMcp(client, config.dashboardPort);
  return { installed, mcp: await getMcpState() };
}

// --- health -----------------------------------------------------------------

export async function getHealth(): Promise<Record<string, unknown>> {
  const config = await loadConfig();
  return {
    ok: true,
    version: APP_VERSION,
    mode: runtimeLayout().mode,
    dashboardPort: config.dashboardPort,
    configDir: configDir(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

/**
 * Write (or refresh) a project's .localhost-aliases.json from the aliases linked to it,
 * so the folder can be cloned elsewhere and re-imported.
 */
export async function writeProjectWorkspaceFile(
  body: Record<string, unknown>,
): Promise<{ path: string; written: boolean; workspaceFile: string; aliases: WorkspaceAliasEntry[] }> {
  const rawPath = typeof body.path === "string" ? body.path.trim() : "";
  if (rawPath === "") throw invalid("path", "A project folder path is required.");
  if (!isAbsolute(rawPath)) throw invalid("path", "The project path must be absolute.");
  const path = normalize(rawPath).replace(/\/+$/, "") || "/";
  if (!(await isDirectory(path))) throw invalid("path", `"${path}" is not a folder on this Mac.`);

  const config = await loadConfig();
  const entries: WorkspaceAliasEntry[] = config.aliases
    .filter((a) => a.projectPath === path && !a.reserved)
    .map((a) => ({ name: a.name, port: a.port, ...(a.description ? { description: a.description } : {}) }));
  if (entries.length === 0) {
    throw invalid("path", "No aliases are linked to that folder yet, so there is nothing to write.");
  }

  const merged = mergeWorkspace(await readWorkspace(path), entries);
  const workspaceFile = await writeWorkspace(path, merged);
  return { path, written: true, workspaceFile, aliases: merged.aliases };
}

/**
 * Refresh the files the privileged script consumes and report what still needs root.
 * It deliberately does NOT apply anything: raising the admin prompt is the tray's job.
 */
export async function prepareApply(options: ServiceOptions = {}): Promise<{
  ok: boolean;
  needsPrompt: boolean;
  system: SystemState;
  sync: SyncReport;
  intent: ApplyIntent;
}> {
  const { system, report } = await sync(options);
  return { ok: report.applied, needsPrompt: report.needsPrompt, system, sync: report, intent: report.intent };
}

/** The polled snapshot: state plus the alias views, in one round trip. */
export async function getStatus(options: ServiceOptions = {}): Promise<StateSnapshot & { aliases: AliasView[] }> {
  const state = await getState(options);
  return { ...state, aliases: await viewsFor(state.config.aliases, state.config, options) };
}

export { ValidationError };
