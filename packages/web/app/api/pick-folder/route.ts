/**
 * POST /api/pick-folder -> { path: string } | { cancelled: true }
 *
 * With no body it opens the native macOS folder chooser. With `{ path }` it
 * instead validates a hand-typed absolute path — the fallback for anyone who
 * cannot use the dialog. Same response shape either way, so the client has one
 * code path.
 */
import { ValidationError } from "@localhost-aliases/core";
import { handle, json, problem } from "../../../lib/http.ts";
import { readJsonBody } from "../../../lib/input.ts";
import { PickFolderError, pickFolder, resolveManualPath } from "../../../lib/folder-picker.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJsonBody(req);
    for (const key of Object.keys(body)) {
      if (key !== "path") {
        throw new ValidationError([{ field: key, message: "is not a recognized field" }]);
      }
    }

    try {
      if (body.path !== undefined) {
        if (typeof body.path !== "string") {
          throw new ValidationError([{ field: "path", message: "must be a string" }]);
        }
        return json({ path: await resolveManualPath(body.path) });
      }
      return json(await pickFolder());
    } catch (error) {
      // The only error class this route reports verbatim: it is written for the
      // user ("still open after 60 seconds"), not leaked internals.
      if (error instanceof PickFolderError) return problem(error.message, error.status);
      throw error;
    }
  });
}
