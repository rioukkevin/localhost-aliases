/**
 * Tool handlers. Pure functions of (client, args) so they can be unit-tested with the
 * HTTP layer stubbed; registration and transport live elsewhere.
 */
import type { AliasView, Project } from "@localhost-aliases/core/types";
import { WORKSPACE_FILENAME } from "@localhost-aliases/core/types";
import {
  DashboardApiError,
  DashboardUnreachableError,
  type DashboardClient,
  type SyncReport,
} from "./client.ts";
import { mechanismSummary } from "./instructions.ts";

export interface ToolResult {
  /** CallToolResult carries an open index signature; mirror it so handlers type-check. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}
function failure(body: string): ToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/**
 * Every tool goes through this. An unreachable dashboard is an expected condition with a
 * fix, not a crash, so it becomes a tool error the model can act on.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DashboardUnreachableError) return failure(error.message);
    if (error instanceof DashboardApiError) return failure(`The dashboard refused the request: ${error.message}`);
    return failure(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Whether the change is live yet. Only root can add a loopback IP or edit /etc/hosts, so
 * the dashboard reports what it could not do itself instead of pretending it is done.
 */
function applyNote(sync: SyncReport | undefined): string {
  if (!sync || sync.applied) return "The change is already live on this Mac.";
  if (!sync.needsPrompt) return "The forwarder picks this up on its own; no admin prompt is needed.";
  return [
    "This needs one macOS admin prompt before it works:",
    ...sync.privileged.map((reason) => `  - ${reason}`),
    "Tell the user to accept the prompt from the Localhost Aliases menu bar app.",
  ].join("\n");
}

function describeAlias(alias: AliasView): string {
  const bits = [
    `${alias.url} -> 127.0.0.1:${alias.port}`,
    `ip=${alias.ip}`,
    `status=${alias.status}`,
  ];
  if (!alias.enabled) bits.push("disabled");
  if (alias.reserved) bits.push("reserved (the dashboard itself)");
  if (alias.projectPath) bits.push(`project=${alias.projectPath}`);
  if (alias.description) bits.push(alias.description);
  return `- ${alias.hostname}  ${bits.join("  ")}`;
}

function renderAliases(aliases: AliasView[]): string {
  if (aliases.length === 0) return "No aliases yet.";
  const lines = aliases.map(describeAlias);
  return [`${aliases.length} alias(es):`, ...lines, "", "status: up = something is listening on the target port."].join("\n");
}

function renderProjects(projects: Project[]): string {
  if (projects.length === 0) {
    return "No projects. A project appears once an alias is linked to a folder path.";
  }
  return projects
    .map((project) => {
      const head = `- ${project.name}  ${project.path}${project.hasWorkspaceFile ? "  (has .localhost-aliases.json)" : ""}`;
      const kids = project.aliases.map((a) => `    ${a.hostname} -> 127.0.0.1:${a.port} (${a.status})`);
      return [head, ...kids].join("\n");
    })
    .join("\n");
}

/** Aliases are addressed by hostname label in conversation and by id in the API. */
async function resolveAlias(client: DashboardClient, ref: string): Promise<AliasView> {
  const aliases = await client.listAliases();
  const needle = ref.trim().toLowerCase();
  const match =
    aliases.find((a) => a.id === ref) ??
    aliases.find((a) => a.name.toLowerCase() === needle) ??
    aliases.find((a) => a.hostname.toLowerCase() === needle);
  if (!match) {
    const known = aliases.map((a) => a.hostname).join(", ") || "none";
    throw new DashboardApiError(404, `No alias matches "${ref}". Existing aliases: ${known}.`);
  }
  return match;
}

// --- handlers ---------------------------------------------------------------

export function listAliases(client: DashboardClient): Promise<ToolResult> {
  return guard(async () => text(renderAliases(await client.listAliases())));
}

export function listProjects(client: DashboardClient): Promise<ToolResult> {
  return guard(async () => text(renderProjects(await client.listProjects())));
}

export interface CreateAliasArgs {
  name: string;
  port: number;
  projectPath?: string;
  description?: string;
}

export function createAlias(client: DashboardClient, args: CreateAliasArgs): Promise<ToolResult> {
  return guard(async () => {
    const { alias, sync } = await client.createAlias({
      name: args.name,
      port: args.port,
      projectPath: args.projectPath ?? null,
      description: args.description ?? null,
    });
    return text(
      [
        `Created ${alias.hostname} -> 127.0.0.1:${alias.port} on ${alias.ip}.`,
        `Open it at ${alias.url} (http only — TLS cannot be terminated for project aliases).`,
        applyNote(sync),
        alias.status === "up"
          ? "Something is already listening on the target port."
          : `Nothing is listening on 127.0.0.1:${alias.port} yet, so the alias will not answer until the dev server starts.`,
      ].join("\n"),
    );
  });
}

export function deleteAlias(client: DashboardClient, args: { alias: string }): Promise<ToolResult> {
  return guard(async () => {
    const found = await resolveAlias(client, args.alias);
    if (found.reserved) {
      return failure(`${found.hostname} is the reserved dashboard alias and cannot be deleted.`);
    }
    const { sync } = await client.deleteAlias(found.id);
    return text(
      [
        `Deleted ${found.hostname}. Its /etc/hosts line and its ${found.ip} loopback address are no longer wanted.`,
        applyNote(sync),
      ].join("\n"),
    );
  });
}

export interface LinkProjectArgs {
  projectPath: string;
  alias?: string;
  importWorkspace?: boolean;
  writeWorkspaceFile?: boolean;
}

export function linkProject(client: DashboardClient, args: LinkProjectArgs): Promise<ToolResult> {
  return guard(async () => {
    if (!args.projectPath.startsWith("/")) {
      return failure(`projectPath must be an absolute path; got "${args.projectPath}".`);
    }
    const aliasIds = args.alias ? [(await resolveAlias(client, args.alias)).id] : [];
    const result = await client.linkProject({
      path: args.projectPath,
      aliasIds,
      importWorkspace: args.importWorkspace !== false,
      writeWorkspaceFile: args.writeWorkspaceFile === true,
    });

    const lines = [`${result.project.name} (${result.project.path}) now has ${result.project.aliases.length} alias(es):`];
    for (const view of result.project.aliases) lines.push(`  ${view.url} -> 127.0.0.1:${view.port} (${view.status})`);
    if (result.created.length > 0) {
      lines.push(
        `Imported ${result.created.length} alias(es) declared in ${WORKSPACE_FILENAME}: ${result.created.map((a) => a.hostname).join(", ")}.`,
      );
    }
    if (result.workspaceFile) lines.push(`Wrote ${result.workspaceFile}.`);
    lines.push(applyNote(result.sync));
    return text(lines.join("\n"));
  });
}

export function usageInstructions(): Promise<ToolResult> {
  return Promise.resolve(text(mechanismSummary()));
}

/** The alias list, as the resource body. Kept next to the tools so both stay in sync. */
export async function aliasesResource(client: DashboardClient): Promise<string> {
  const aliases = await client.listAliases();
  return JSON.stringify({ aliases }, null, 2);
}
