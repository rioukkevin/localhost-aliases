import { problem, route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * There is no uninstall endpoint, and there must not be one.
 *
 * An uninstall stops a root process, edits /etc/hosts, drops loopback addresses and finally
 * deletes the app that serves this very route. The dashboard runs unprivileged and cannot do
 * any of it. What the settings drawer does instead is ASK: POST /api/privileged/request with
 * kind "uninstall", which the menu-bar app picks up, confirms, and runs through the teardown
 * script shipped inside the bundle.
 */
export const POST = route(async () =>
  problem(
    501,
    'The dashboard never runs privileged commands. Ask the menu-bar app instead: POST /api/privileged/request with { "kind": "uninstall" } — that is what the Uninstall button in Settings does.',
  ),
);
