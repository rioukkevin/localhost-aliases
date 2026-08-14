/**
 * The one process-wide AutoApply scheduler, wired to the real clock, the real timer and
 * the real dashboard/tray channel.
 *
 * Kept apart from auto-apply.ts so the policy stays pure and testable, and apart from
 * service.ts so the import graph stays acyclic:
 *
 *   service.ts -> auto-apply-runtime.ts -> privileged-channel.ts -> runtime-files.ts
 *   service.ts -> auto-apply.ts (no dashboard imports at all)
 */
import { AutoApply, createAutoApply } from "./auto-apply.ts";
import { isTrayAlive, readResultFor, requestPrivileged } from "./privileged-channel.ts";

let instance: AutoApply | null = null;

export function autoApplyScheduler(): AutoApply {
  instance ??= createAutoApply({
    now: () => Date.now(),
    setTimer(fn, ms) {
      const handle = setTimeout(fn, ms);
      // The debounce must never be the reason a process stays alive.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    },
    clearTimer(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    trayAlive: () => isTrayAlive(),
    queue: () => requestPrivileged("apply"),
    readResult: (id) => readResultFor(id),
  });
  return instance;
}
