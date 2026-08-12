/**
 * Shapes the API's payloads into exactly what the tools promise, and renders the
 * human-readable half of every tool result.
 *
 * Normalising here (rather than passing API objects straight through) means the
 * declared outputSchema can never fail to validate because the dashboard omitted
 * an optional field.
 */
import type { AliasStatus, AliasView, Project } from "@localhost-aliases/core";

export interface AliasSummary {
  id: string;
  name: string;
  hostname: string;
  url: string;
  port: number;
  target: string;
  projectPath: string | null;
  description: string | null;
  enabled: boolean;
  status: AliasStatus;
}

export interface ProjectSummary {
  path: string;
  name: string;
  hasWorkspaceFile: boolean;
  aliases: AliasSummary[];
}

const STATUSES: AliasStatus[] = ["up", "down", "unknown"];

export function toAliasSummary(alias: AliasView): AliasSummary {
  const name = alias.name ?? "";
  const hostname = alias.hostname ?? name;
  return {
    id: alias.id ?? "",
    name,
    hostname,
    url: alias.url ?? `http://${hostname}`,
    port: alias.port ?? 0,
    target: alias.target ?? "127.0.0.1",
    projectPath: alias.projectPath ?? null,
    description: alias.description ?? null,
    enabled: alias.enabled ?? true,
    status: STATUSES.includes(alias.status) ? alias.status : "unknown",
  };
}

export function toProjectSummary(project: Project): ProjectSummary {
  return {
    path: project.path ?? "",
    name: project.name ?? "",
    hasWorkspaceFile: project.hasWorkspaceFile === true,
    aliases: (project.aliases ?? []).map(toAliasSummary),
  };
}

const DOT: Record<AliasStatus, string> = { up: "●", down: "○", unknown: "·" };

/** One alias per line: status, hostname, where it forwards, and its context. */
export function renderAlias(alias: AliasSummary): string {
  const bits = [
    `${DOT[alias.status]} ${alias.hostname}`,
    `-> ${alias.target}:${alias.port}`,
    `[${alias.status}]`,
    alias.url,
  ];
  if (!alias.enabled) bits.push("(disabled)");
  if (alias.projectPath) bits.push(`project: ${alias.projectPath}`);
  if (alias.description) bits.push(`"${alias.description}"`);
  return bits.join("  ");
}

export function renderAliasList(aliases: AliasSummary[]): string {
  if (aliases.length === 0) {
    return "No aliases are registered yet. Create one with create_alias { name, port } — it will be reachable at <name>.local once the dev server is listening.";
  }
  const up = aliases.filter((a) => a.status === "up").length;
  const header = `${aliases.length} alias${aliases.length === 1 ? "" : "es"} (${up} with a live upstream):`;
  const legend =
    '"down" means the alias is registered but nothing is listening on that port yet — start the dev server and it works.';
  return [header, ...aliases.map((a) => `  ${renderAlias(a)}`), "", legend].join("\n");
}

export function renderProjectList(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return "No projects have aliases attached yet. Pass projectPath to create_alias, or use link_project, to associate aliases with a folder.";
  }
  const lines: string[] = [`${projects.length} project${projects.length === 1 ? "" : "s"}:`];
  for (const project of projects) {
    lines.push(
      `  ${project.name}  (${project.path})  workspace file: ${project.hasWorkspaceFile ? "yes (.localhost-aliases.json)" : "no — optional, nothing depends on it"}`,
    );
    for (const alias of project.aliases) lines.push(`      ${renderAlias(alias)}`);
  }
  return lines.join("\n");
}
