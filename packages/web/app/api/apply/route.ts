import { handle, json } from "../../../lib/http.ts";
import { applyNow } from "../../../lib/service.ts";

export const dynamic = "force-dynamic";

/**
 * Force-pushes the current desired state to the helper. A helper that is absent
 * is not a server error: the response is 200 with `applied: false` and a warning.
 */
export async function POST(): Promise<Response> {
  return handle(async () => {
    const outcome = await applyNow();
    return json({ ...outcome, warning: outcome.warning ?? undefined });
  });
}
