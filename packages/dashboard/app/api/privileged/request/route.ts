import { isPrivilegedKind, isTrayAlive, requestPrivileged } from "../../../../lib/privileged-channel.ts";
import { autoApplyScheduler } from "../../../../lib/auto-apply-runtime.ts";
import { invalid, problem, readJson, route } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * Ask the menu-bar app to run the privileged batch behind its one admin prompt.
 *
 * If the tray is not running, the request is refused rather than queued: a file nobody
 * reads would leave the UI waiting on a prompt that is never going to appear.
 */
export const POST = route(async (request: Request) => {
  const body = await readJson(request);
  const kind = body.kind ?? "apply";
  if (!isPrivilegedKind(kind)) throw invalid("kind", 'kind must be "apply" or "uninstall".');

  if (!(await isTrayAlive())) {
    return problem(
      409,
      "The Localhost Aliases menu-bar app is not running, so nothing would pick this up. Start it and try again, or run the command yourself.",
      { trayAlive: false, request: null },
    );
  }

  const queued = await requestPrivileged(kind);
  // An explicit click is a user action, so it clears a deferred or failed state and takes
  // over as the run in flight. Automatic apply then reports on this request rather than
  // scheduling a competing one.
  const autoApply = await autoApplyScheduler().noteExplicitRequest(queued);
  return { request: queued, trayAlive: true, autoApply };
});
