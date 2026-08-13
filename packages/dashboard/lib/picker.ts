/**
 * The native folder chooser. Isolated from service.ts because it is the one place the
 * dashboard shows UI outside the browser.
 *
 * osascript is run WITHOUT administrator privileges — `choose folder` is an ordinary
 * user dialog. Cancelling it is not an error: AppleScript reports -128, which we
 * translate into `cancelled: true` rather than a 500.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const OSASCRIPT = "/usr/bin/osascript";
const TIMEOUT_MS = 60_000;
/** Fixed on purpose: a caller-supplied prompt would be script injection. */
const PROMPT = "Choose a project folder";
const CANCEL_CODE = "-128";

export interface PickFolderResult {
  path: string | null;
  cancelled: boolean;
}

/** Stub mode keeps tests and CI away from a modal dialog nobody can dismiss. */
function stubPath(): string {
  return process.env.LA_FOLDER_PICKER_PATH ?? homedir();
}

/** `POSIX path of` yields a trailing slash; every other path in the app has none. */
function tidy(posixPath: string): string {
  const trimmed = posixPath.trim();
  if (trimmed === "" || trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

export async function pickFolder(): Promise<PickFolderResult> {
  if (process.env.LA_FOLDER_PICKER === "stub") {
    return { path: tidy(stubPath()), cancelled: false };
  }

  return new Promise<PickFolderResult>((resolve, reject) => {
    const child = spawn(
      OSASCRIPT,
      ["-e", `set chosen to choose folder with prompt "${PROMPT}"`, "-e", "POSIX path of chosen"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Kill only the child we started, by its own PID. Never a pattern, never a group.
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone between the timeout firing and this call.
        }
      }
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ path: null, cancelled: true });
        return;
      }
      if (code === 0) {
        const path = tidy(stdout);
        resolve(path === "" ? { path: null, cancelled: true } : { path, cancelled: false });
        return;
      }
      // "User canceled. (-128)" — the normal way this dialog ends.
      if (stderr.includes(CANCEL_CODE)) {
        resolve({ path: null, cancelled: true });
        return;
      }
      reject(new Error(`osascript exited with code ${String(code)}: ${stderr.trim()}`));
    });
  });
}
