import { loadConfig } from "@localhost-aliases/core";
import { updateSettingsAndSync } from "./service.ts";

/**
 * Align config.dashboardPort with the port this process was actually told to bind, and
 * re-sync the derived desired state so the reserved index alias forwards to the right place.
 * Never fatal: a dashboard that boots is worth more than one that refuses over a mismatch.
 */
export async function reconcileDashboardPort(): Promise<void> {
  const bound = Number(process.env.LA_DASHBOARD_PORT ?? process.env.PORT ?? 0);
  if (!Number.isInteger(bound) || bound < 1 || bound > 65535) return;

  try {
    const config = await loadConfig();
    if (config.dashboardPort === bound) return;

    console.log(`[startup] bound :${bound} but config says :${config.dashboardPort} — correcting config`);
    // userInitiated: false — nobody asked for this, so it must never raise an admin prompt.
    // Startup reconciliation and reboot drift surface the banner and wait for the user.
    await updateSettingsAndSync({ dashboardPort: bound }, { userInitiated: false });
  } catch (error) {
    console.error(`[startup] could not reconcile the dashboard port: ${String(error)}`);
  }
}
