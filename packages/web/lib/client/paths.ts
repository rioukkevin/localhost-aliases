/**
 * Path presentation helpers. The browser has no idea what $HOME is, so the home
 * directory is handed down from the server component that renders the page.
 */

/** Mirrors WORKSPACE_FILENAME in packages/core/src/types.ts (core is Bun-only). */
export const WORKSPACE_FILENAME = ".localhost-aliases.json";

/** `/Users/kevin/code/app` -> `~/code/app`. Anything else is returned unchanged. */
export function abbreviateHome(path: string, home: string): string {
  if (!home) return path;
  const root = home.replace(/\/+$/, "");
  if (root === "" || path === root) return path === root ? "~" : path;
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}
