import { prepareApply } from "../../../lib/service.ts";
import { route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * Refreshes desired-state.json and routes.json and reports what still needs root.
 * The dashboard never runs a privileged command: `intent` is for the tray to execute.
 */
export const POST = route(async () => prepareApply());
