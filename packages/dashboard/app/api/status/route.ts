import { getStatus } from "../../../lib/service.ts";
import { isTrayAlive } from "../../../lib/privileged-channel.ts";
import { route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * The one endpoint the UI polls: config + alias views + live system state, plus
 * the menu-bar app's heartbeat. Liveness rides along here so the dashboard keeps
 * a single poller — the status indicator reads the same snapshot as everything else.
 */
export const GET = route(async () => {
  const [status, trayAlive] = await Promise.all([getStatus(), isTrayAlive()]);
  return { ...status, trayAlive };
});
