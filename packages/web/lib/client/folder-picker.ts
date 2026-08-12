/**
 * Browser side of the native folder picker: one POST, two ways to call it.
 *
 * Kept out of `lib/client/api.ts` on purpose — that module is the typed mirror of
 * the alias/settings/MCP API, and this endpoint is a local OS affordance rather
 * than app state.
 */

export type PickFolderResponse = { path: string } | { cancelled: true };

interface ApiProblem {
  error?: unknown;
  issues?: { field?: unknown; message?: unknown }[];
}

function describe(status: number, body: ApiProblem | null): string {
  const issues = Array.isArray(body?.issues)
    ? body.issues
        .map((i) => (typeof i?.message === "string" ? String(i.message) : ""))
        .filter(Boolean)
        .join("; ")
    : "";
  if (issues !== "") return issues;
  if (typeof body?.error === "string" && body.error !== "") return body.error;
  return `The folder picker failed (HTTP ${status}).`;
}

async function post(body: Record<string, unknown>): Promise<PickFolderResponse> {
  let res: Response;
  try {
    res = await fetch("/api/pick-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("The dashboard is not reachable.");
  }

  const parsed = (await res.json().catch(() => null)) as (PickFolderResponse & ApiProblem) | null;
  if (!res.ok) throw new Error(describe(res.status, parsed));
  if (parsed === null) throw new Error("The folder picker returned an unreadable response.");
  return parsed;
}

/** Opens the native dialog. Resolves to `{ cancelled: true }` if the user backs out. */
export function requestFolder(): Promise<PickFolderResponse> {
  return post({});
}

/** Asks the server to validate a hand-typed path. The server is the authority. */
export function submitFolderPath(path: string): Promise<PickFolderResponse> {
  return post({ path });
}

/**
 * `/Users/kevin/code/app` -> `~/code/app`.
 *
 * `lib/client/paths.ts` has the exact version, but it needs $HOME handed down
 * from a server component and FolderPickerProps is frozen without a `home` prop.
 * On macOS — the only platform this app runs on — every home directory is
 * `/Users/<name>`, with `/Users/Shared` the one reserved exception.
 */
export function abbreviateUserHome(path: string): string {
  const match = /^\/Users\/([^/]+)(\/.*)?$/.exec(path);
  if (match === null || match[1] === "Shared") return path;
  return `~${match[2] ?? ""}`;
}
