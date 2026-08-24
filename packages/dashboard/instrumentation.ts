/**
 * Runs once per server start.
 *
 * The tray launches us with LA_DASHBOARD_PORT taken from config.dashboardPort, so the two
 * normally agree. They can diverge if that port was occupied and the launcher picked another:
 * config would still claim the old one, and the `index.test` route — which forwards to
 * config.dashboardPort — would point at nothing. So the port we actually bound wins, and the
 * config is corrected to match reality.
 *
 * NOTE: Next compiles this file for the edge runtime too, and an early `return` is not
 * constant-foldable — edge-webpack would then try to bundle core's node:fs and fail the build,
 * taking /api/health down with it. Hence the import lives INSIDE the nodejs branch.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reconcileDashboardPort } = await import("./lib/startup.ts");
    await reconcileDashboardPort();
  }
}
