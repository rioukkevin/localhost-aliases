import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";

/** `/Users/kevin/code/app` → `~/code/app`. The home dir is inferred from the path itself. */
export function tildePath(path: string, home?: string | null): string {
  if (!path) return path;
  const h = home ?? inferHome(path);
  if (h && path === h) return "~";
  if (h && path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
  return path;
}

/** `/Users/<name>/…` is the only home shape on macOS, so it can be read off the path. */
function inferHome(path: string): string | null {
  const m = /^(\/Users\/[^/]+)(\/|$)/.exec(path);
  return m ? m[1]! : null;
}

export function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function countLabel(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The optimistic row shown between submit and the server's answer. */
export function pendingAlias(input: CreateAliasInput, tld: string): AliasView {
  const now = new Date().toISOString();
  return {
    id: `pending-${input.name}-${now}`,
    name: input.name,
    port: input.port,
    ip: "…",
    projectPath: input.projectPath ?? null,
    description: input.description ?? null,
    enabled: input.enabled ?? true,
    reserved: false,
    createdAt: now,
    updatedAt: now,
    hostname: `${input.name}.${tld}`,
    url: `http://${input.name}.${tld}`,
    status: "unknown",
  };
}

export function isPending(alias: AliasView): boolean {
  return alias.id.startsWith("pending-");
}

/** Aliases are always shown as `http://` — nothing sits in the traffic path to terminate TLS. */
export function urlOf(alias: AliasView, tld: string): string {
  return alias.url || `http://${alias.name}.${tld}`;
}
