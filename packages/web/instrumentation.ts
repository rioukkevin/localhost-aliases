/**
 * One push of the desired state when the dashboard process starts.
 *
 * The helper is stateless on purpose: it holds no routes until someone applies
 * some. In production the helper is a LaunchDaemon (starts at boot) and the
 * dashboard is a LaunchAgent (starts at login), so without this the machine sits
 * with `/etc/hosts` resolving every alias and the proxy answering all of them
 * with the branded 404 page until the user happens to edit something.
 *
 * Verified failing before this existed: restart the helper under a running
 * dashboard and `GET /status` reports `routes: 0` forever.
 *
 * The `NEXT_RUNTIME` check must WRAP the import, not guard it with an early
 * return: Next compiles this file for the edge runtime as well, and only a
 * branch it can constant-fold gets pruned. With the import outside the branch,
 * edge-webpack tries to bundle core's `node:fs/promises` and the whole dev
 * server starts answering 500 (observed — /api/health, everything).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startupApply } = await import("./lib/startup.ts");
    await startupApply();
  }
}
