import { handle, json } from "../../../lib/http.ts";
import { getStatus } from "../../../lib/service.ts";

export const dynamic = "force-dynamic";

/** Renders fine with no helper installed — that is the normal first-run state. */
export async function GET(): Promise<Response> {
  return handle(async () => json(await getStatus()));
}
