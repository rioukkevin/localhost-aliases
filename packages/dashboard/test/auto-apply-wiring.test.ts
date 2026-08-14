/**
 * REGRESSION LOCK for the seam that had no owner: the service layer publishes
 * `autoApply` on /api/status, and the UI reads it off the polled snapshot — but nothing
 * carried it across. `fetchStatus` whitelists fields and `StatusState` had no slot, so
 * the field was dropped in transit and every surface read `idle` forever.
 *
 * These tests fail if that seam is ever cut again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fetchStatus, toAutoApplyStatus } from "../lib/client/api.ts";
import { refreshStatus, resetStatus, snapshot } from "../lib/client/status-store.ts";
import { readAutoApply, readApply, autoApplyEnabled } from "../components/shell/auto-apply-read.ts";

const base = {
  config: { version: 2, tld: "local", dashboardPort: 7788, https: false, autoApply: true, aliases: [] },
  aliases: [],
  system: { loopbackIps: [], managedHosts: [], forwarder: null, applied: false, drift: [] },
  sync: { applied: false, needsPrompt: true, drift: [], privileged: [], unprivileged: [], intent: {} },
  trayAlive: true,
};

const withAuto = (autoApply: unknown) => ({ ...base, autoApply });

const real = globalThis.fetch;
function stub(body: unknown): void {
  globalThis.fetch = (() => Promise.resolve(Response.json(body))) as unknown as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = real;
  resetStatus();
});

describe("the /api/status -> store -> UI seam", () => {
  test("fetchStatus carries autoApply instead of dropping it", async () => {
    stub(withAuto({ state: "deferred", enabled: true, requestId: "r1", scheduledInMs: null, dirty: false, error: null, reason: "You dismissed the administrator prompt." }));
    const payload = await fetchStatus();
    expect(payload.autoApply).not.toBeNull();
    expect(payload.autoApply?.state).toBe("deferred");
    expect(payload.autoApply?.reason).toContain("dismissed");
  });

  test("the store keeps it, and the UI reads the real phase — not idle", async () => {
    stub(withAuto({ state: "prompting", enabled: true, requestId: "r2", scheduledInMs: null, dirty: false, error: null, reason: null }));
    await refreshStatus();
    expect(snapshot().autoApply?.state).toBe("prompting");

    const reading = readAutoApply(snapshot());
    expect(reading.phase).toBe("prompting"); // this was "idle" before the fix
    expect(readApply(reading)?.value).toBe("waiting");
  });

  test("a failed run reaches the UI with the REAL error, not a generic one", async () => {
    stub(withAuto({ state: "failed", enabled: true, requestId: null, scheduledInMs: null, dirty: false, error: "apply.sh exited 2: could not write /etc/hosts", reason: "apply.sh exited 2: could not write /etc/hosts" }));
    await refreshStatus();
    const apply = readApply(readAutoApply(snapshot()));
    expect(apply?.phase).toBe("failed");
    expect(apply?.note).toBe("apply.sh exited 2: could not write /etc/hosts");
    expect(apply?.retryable).toBe(true);
  });

  test("deferred is retryable and scheduled/prompting are not", async () => {
    for (const [state, retryable] of [["scheduled", false], ["prompting", false], ["deferred", true], ["failed", true]] as const) {
      stub(withAuto({ state, enabled: true, requestId: null, scheduledInMs: null, dirty: false, error: null, reason: null }));
      resetStatus();
      await refreshStatus();
      expect(readApply(readAutoApply(snapshot()))?.retryable).toBe(retryable);
    }
  });

  test("idle publishes no gauge at all — the manual UI, unchanged", async () => {
    stub(withAuto({ state: "idle", enabled: true, requestId: null, scheduledInMs: null, dirty: false, error: null, reason: null }));
    await refreshStatus();
    expect(readApply(readAutoApply(snapshot()))).toBeNull();
  });

  test("a server that never heard of autoApply reads as idle, never as a lie", async () => {
    stub(base); // no autoApply key at all
    await refreshStatus();
    expect(snapshot().autoApply).toBeNull();
    expect(readAutoApply(snapshot()).phase).toBe("idle");
    expect(readApply(readAutoApply(snapshot()))).toBeNull();
  });

  test("losing the server drops the reading rather than asserting a stale one", async () => {
    stub(withAuto({ state: "prompting", enabled: true, requestId: "r3", scheduledInMs: null, dirty: false, error: null, reason: null }));
    await refreshStatus();
    expect(snapshot().autoApply?.state).toBe("prompting");

    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch;
    await refreshStatus();
    expect(snapshot().reachable).toBe(false);
    // Must not still claim "waiting for your password" about a Mac we cannot see.
    expect(snapshot().autoApply).toBeNull();
    expect(readApply(readAutoApply(snapshot()))).toBeNull();
  });

  test("garbage in the field is ignored, not crashed on", () => {
    for (const junk of [null, undefined, 42, "prompting", {}, { state: "banana" }, []]) {
      expect(toAutoApplyStatus(junk)).toBeNull();
    }
  });

  test("the setting reaches the UI, and a config predating the field reads true", async () => {
    stub({ ...withAuto({ state: "idle", enabled: false, requestId: null, scheduledInMs: null, dirty: false, error: null, reason: null }), config: { ...base.config, autoApply: false } });
    await refreshStatus();
    expect(autoApplyEnabled(snapshot().config)).toBe(false);

    resetStatus();
    const { autoApply: _drop, ...older } = base.config as Record<string, unknown>;
    stub({ ...base, config: older });
    await refreshStatus();
    expect(autoApplyEnabled(snapshot().config)).toBe(true); // default true, per the spec
  });
});
