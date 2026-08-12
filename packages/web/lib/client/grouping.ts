/**
 * Turning a flat alias list into projects, client-side.
 *
 * `Alias.projectPath` is optional and stays that way: an alias with no folder is
 * not an error, it lands in the trailing "Unassigned" group. That is the whole
 * reason grouping happens here rather than being a server-side requirement.
 */
import type { AliasView } from "@localhost-aliases/core";

export const UNASSIGNED_LABEL = "Unassigned";

export interface AliasGroup {
  /** Absolute project folder, or null for the Unassigned group. */
  path: string | null;
  /** Folder basename, or "Unassigned". */
  name: string;
  aliases: AliasView[];
  /** Whether the folder carries a `.localhost-aliases.json`. */
  hasWorkspaceFile: boolean;
  /** Aliases whose upstream answered on the last probe. */
  live: number;
}

/** POSIX basename. The browser has no `node:path`, and paths here are absolute. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name === "" ? path : name;
}

function byName(a: AliasView, b: AliasView): number {
  return a.name.localeCompare(b.name);
}

function live(aliases: AliasView[]): number {
  return aliases.filter((alias) => alias.status === "up").length;
}

/**
 * Groups by folder, sorted by folder name; the Unassigned group is always last
 * and is omitted entirely when every alias belongs somewhere.
 */
export function groupAliases(
  aliases: AliasView[],
  workspaceFiles: ReadonlySet<string> = new Set(),
): AliasGroup[] {
  const byPath = new Map<string, AliasView[]>();
  const orphans: AliasView[] = [];

  for (const alias of aliases) {
    if (!alias.projectPath) {
      orphans.push(alias);
      continue;
    }
    const list = byPath.get(alias.projectPath) ?? [];
    list.push(alias);
    byPath.set(alias.projectPath, list);
  }

  const groups: AliasGroup[] = [...byPath.entries()]
    .map(([path, list]) => ({
      path,
      name: folderName(path),
      aliases: [...list].sort(byName),
      hasWorkspaceFile: workspaceFiles.has(path),
      live: live(list),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  if (orphans.length > 0) {
    groups.push({
      path: null,
      name: UNASSIGNED_LABEL,
      aliases: [...orphans].sort(byName),
      hasWorkspaceFile: false,
      live: live(orphans),
    });
  }
  return groups;
}

/** Only the real folders, for the "move to another project" picker. */
export function projectGroups(groups: AliasGroup[]): AliasGroup[] {
  return groups.filter((group) => group.path !== null);
}
