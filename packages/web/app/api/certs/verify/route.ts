import { handle, json } from "../../../../lib/http.ts";
import { verifyHttps } from "../../../../lib/certs.ts";
import { readJsonBody } from "../../../../lib/input.ts";

export const dynamic = "force-dynamic";

/**
 * Makes one real HTTPS request to an alias and reports what a browser would conclude.
 * POST because it is an action with a cost, not a cached view of state.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJsonBody(req);
    const hostname = typeof body.hostname === "string" ? body.hostname : undefined;
    return json({ verification: await verifyHttps(hostname) });
  });
}
