import { handle, json } from "../../../../lib/http.ts";
import { trustCA } from "../../../../lib/certs.ts";

export const dynamic = "force-dynamic";

/**
 * Adds the local CA to the user's login keychain.
 *
 * macOS raises an authentication dialog for this, so it is POST-only and reached from a
 * single button in onboarding — never from a poll, a page load or a startup hook. When the
 * user cancels the dialog the command fails, and that is reported as `ok: false` rather
 * than as a server error: cancelling is a valid answer.
 */
export async function POST(): Promise<Response> {
  return handle(async () => json(await trustCA()));
}
