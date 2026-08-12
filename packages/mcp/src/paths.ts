/**
 * The paths this server tells an agent about.
 *
 * Every one of them is overridable at runtime (LA_HOSTS_PATH, LA_CONFIG_DIR,
 * LA_DASHBOARD_PORT), so the transparency prose must never hardcode the production
 * values: naming a file the process will not actually touch is worse than saying
 * nothing. Resolved per call, from core, so dev and test runs describe themselves
 * truthfully.
 */
import { HOSTS_PATH, caDir, configPath, dashboardUrl } from "@localhost-aliases/core";

export interface LivePaths {
  /** The hosts file the root helper rewrites (LA_HOSTS_PATH). */
  hosts: string;
  /** The alias config the dashboard owns (LA_CONFIG_DIR). */
  config: string;
  /** Local certificate authority material, created only when HTTPS is enabled. */
  ca: string;
  /** Base URL of the dashboard API these tools are a client of. */
  dashboard: string;
}

export function livePaths(): LivePaths {
  return {
    hosts: HOSTS_PATH,
    config: configPath(),
    ca: caDir(),
    dashboard: dashboardUrl(),
  };
}
