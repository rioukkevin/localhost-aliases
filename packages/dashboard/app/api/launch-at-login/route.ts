import { readLaunchAtLogin, requestLaunchAtLogin } from "../../../lib/launch-at-login.ts";
import { readJson, route, invalid } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

const ACTIONS = ["enable", "disable", "refresh"] as const;

/**
 * `GET  /api/launch-at-login`  -> LaunchAtLoginState
 * `PUT  /api/launch-at-login`  { action: "enable" | "disable" | "refresh" } -> pending state
 *
 * The dashboard cannot register a login item — only the menu-bar app can call
 * `SMAppService`. PUT therefore writes an ask and returns the state as it STILL IS, with
 * `pending: true`. The tray answers by republishing login-item.json with the status it read
 * back from the system, never with the value it was handed. See lib/launch-at-login.ts and
 * apps/tray/Sources/LoginItem.swift — one contract, written down on both sides.
 */
export const GET = route(async () => readLaunchAtLogin());

export const PUT = route(async (request: Request) => {
  const body = await readJson(request);
  const action = body.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    throw invalid("action", 'action must be "enable", "disable" or "refresh".');
  }
  return requestLaunchAtLogin(action as (typeof ACTIONS)[number]);
});
