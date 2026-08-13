import { getStatus } from "../../../lib/service.ts";
import { route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

/** The one endpoint the UI polls: config + alias views + live system state. */
export const GET = route(async () => getStatus());
