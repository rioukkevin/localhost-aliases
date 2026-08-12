/**
 * Shell commands the UI offers as copyable text.
 *
 * These mirror `helperInstallCommand()` / `helperStartCommand()` in core, which
 * cannot be imported here (Bun-only barrel). If they ever diverge, core wins.
 */
export const HELPER_INSTALL_COMMAND = "sudo ./scripts/install.sh";
export const HELPER_START_COMMAND =
  "sudo launchctl kickstart -k system/dev.localhost-aliases.helper";

/** launchd label of the per-user agent that starts the dashboard at login. */
export const WEB_AGENT_LABEL = "dev.localhost-aliases.web";

/** Read-only: shows whether launchd knows about the dashboard agent. */
export const AGENT_STATUS_COMMAND = `launchctl print gui/$(id -u)/${WEB_AGENT_LABEL}`;

/** Stops the dashboard from starting at login (until the next install). */
export const AGENT_DISABLE_COMMAND = `launchctl bootout gui/$(id -u)/${WEB_AGENT_LABEL}`;

/** Copies text and resolves to whether it worked, without ever throwing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (clipboard API needs a secure context)
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
