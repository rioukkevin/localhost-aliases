/**
 * Automatic apply, tested with the clock, the timer, the tray heartbeat and the privileged
 * runner ALL stubbed. Nothing in this file can raise a macOS admin prompt, touch /etc/hosts,
 * lo0, or run a privileged command: the only thing a "queue" does here is push onto an array.
 *
 * The rules under test, in the order they matter:
 *   never loop on cancel, never prompt without a user-initiated cause, coalesce, one in flight.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyRequestPath,
  buildDesiredState,
  loadConfig,
  updateSettings,
  type Config,
  type PrivilegedRequest,
  type PrivilegedResult,
} from "@localhost-aliases/core";
import { AUTO_APPLY_DEBOUNCE_MS, createAutoApply, type AutoApply, type AutoApplyDeps } from "../lib/auto-apply.ts";
import {
  createAliasAndSync,
  deleteAliasAndSync,
  getState,
  getStatus,
  updateAliasAndSync,
  updateSettingsAndSync,
} from "../lib/service.ts";
import { reconcileDashboardPort } from "../lib/startup.ts";
import { appliedProbes, sandbox, stubProbes, type Sandbox } from "./helpers.ts";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
  await mkdir(box.configDir, { recursive: true });
});
afterEach(() => box.cleanup());

// --- the harness ------------------------------------------------------------

interface FakeTimer {
  at: number;
  fn: () => void;
}

interface Harness {
  scheduler: AutoApply;
  /** Every request the scheduler asked for. Length === number of admin prompts raised. */
  queued: PrivilegedRequest[];
  /** Move the fake clock forward and run whatever the timer would have run. */
  advance(ms: number): Promise<void>;
  /** Answer the request currently in flight, the way the tray would. */
  answer(patch?: Partial<PrivilegedResult>): void;
  setTrayAlive(alive: boolean): void;
  /** How the tray failed to answer at all: nothing is ever written. */
  goSilent(): void;
}

function harness(): Harness {
  let now = 1_000_000;
  let alive = true;
  let answering = true;
  const timers: FakeTimer[] = [];
  const queued: PrivilegedRequest[] = [];
  const results = new Map<string, PrivilegedResult>();

  const deps: AutoApplyDeps = {
    now: () => now,
    setTimer(fn, ms) {
      const timer: FakeTimer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      const index = timers.indexOf(handle as FakeTimer);
      if (index >= 0) timers.splice(index, 1);
    },
    trayAlive: async () => alive,
    queue: async () => {
      const request: PrivilegedRequest = {
        id: `request-${queued.length + 1}`,
        kind: "apply",
        requestedAt: new Date(now).toISOString(),
      };
      queued.push(request);
      return request;
    },
    readResult: async (id) => results.get(id) ?? null,
  };

  const scheduler = createAutoApply(deps);

  return {
    scheduler,
    queued,
    async advance(ms: number) {
      now += ms;
      for (;;) {
        await scheduler.whenSettled();
        const due = timers.filter((t) => t.at <= now);
        if (due.length === 0) return;
        for (const timer of due) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
        await scheduler.whenSettled();
      }
    },
    answer(patch: Partial<PrivilegedResult> = {}) {
      if (!answering) return;
      const request = queued[queued.length - 1];
      if (!request) throw new Error("nothing was queued, so there is nothing to answer");
      results.set(request.id, {
        id: request.id,
        kind: request.kind,
        ok: true,
        cancelled: false,
        error: null,
        startedAt: request.requestedAt,
        finishedAt: new Date(now).toISOString(),
        ...patch,
      });
    },
    setTrayAlive(value: boolean) {
      alive = value;
    },
    goSilent() {
      answering = false;
    },
  };
}

/** Service options that stub the machine AND the scheduler. Used by every service test. */
function opts(h: Harness, probes = stubProbes()) {
  return { probes, probeStatuses: false as const, scheduler: h.scheduler };
}

const PAST_DEBOUNCE = AUTO_APPLY_DEBOUNCE_MS + 1;

// ---------------------------------------------------------------------------
// The scheduler on its own
// ---------------------------------------------------------------------------

describe("scheduler: coalescing", () => {
  test("one mutation queues exactly one request, once the window closes", async () => {
    const h = harness();

    expect((await h.scheduler.notifyMutation({ needsRoot: true })).state).toBe("scheduled");
    expect(h.queued).toHaveLength(0);

    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);
    expect((await h.scheduler.status()).state).toBe("prompting");

    // Time passing on its own never queues anything more.
    await h.advance(60_000);
    expect(h.queued).toHaveLength(1);
  });

  test("three mutations in quick succession are one request", async () => {
    const h = harness();

    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(300);
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(300);
    await h.scheduler.notifyMutation({ needsRoot: true });
    expect(h.queued).toHaveLength(0);

    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);
  });

  test("each mutation restarts the quiet period", async () => {
    const h = harness();

    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(AUTO_APPLY_DEBOUNCE_MS - 100);
    expect(h.queued).toHaveLength(0);

    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(AUTO_APPLY_DEBOUNCE_MS - 100);
    expect(h.queued).toHaveLength(0);

    await h.advance(200);
    expect(h.queued).toHaveLength(1);
  });

  test("a change that does not need root queues nothing at all", async () => {
    const h = harness();
    const status = await h.scheduler.notifyMutation({ needsRoot: false });

    expect(status.state).toBe("idle");
    await h.advance(60_000);
    expect(h.queued).toHaveLength(0);
  });

  test("a port-only change does not cancel a window already open for a real change", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.scheduler.notifyMutation({ needsRoot: false });

    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);
  });
});

describe("scheduler: never loop on cancel", () => {
  test("a cancelled result parks in deferred and never re-queues", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: true, error: null });

    const status = await h.scheduler.status();
    expect(status.state).toBe("deferred");
    expect(status.error).toBeNull();
    expect(status.reason).toContain("dismissed");

    // Poll for ten minutes of fake time. Not one more prompt.
    for (let i = 0; i < 60; i++) {
      await h.advance(10_000);
      await h.scheduler.status();
    }
    expect(h.queued).toHaveLength(1);
  });

  test("a cancel wins over a mutation that landed mid-run: still no re-queue", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);

    await h.scheduler.notifyMutation({ needsRoot: true }); // marks dirty
    expect((await h.scheduler.status()).dirty).toBe(true);

    h.answer({ ok: false, cancelled: true, error: null });
    const status = await h.scheduler.status();

    expect(status.state).toBe("deferred");
    expect(status.dirty).toBe(false);
    await h.advance(120_000);
    expect(h.queued).toHaveLength(1);
  });

  test("a NEW mutation after a cancel is allowed to queue again", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: true, error: null });
    expect((await h.scheduler.status()).state).toBe("deferred");

    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(2);
  });

  test("an explicit user action clears the deferred state", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: true, error: null });
    await h.scheduler.status();

    const status = await h.scheduler.noteExplicitRequest({
      id: "clicked",
      kind: "apply",
      requestedAt: new Date().toISOString(),
    });
    expect(status.state).toBe("prompting");
    expect(status.requestId).toBe("clicked");
    expect(h.queued).toHaveLength(1); // the click wrote its own request, not the scheduler
  });

  test("a failed result parks too, with the real error and no retry", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: false, error: "ifconfig: permission denied" });

    const status = await h.scheduler.status();
    expect(status.state).toBe("failed");
    expect(status.error).toBe("ifconfig: permission denied");

    await h.advance(300_000);
    expect(h.queued).toHaveLength(1);
  });

  test("a request nobody ever answers is written off, not retried", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    h.goSilent();

    await h.advance(200_000);
    const status = await h.scheduler.status();
    expect(status.state).toBe("failed");
    expect(status.requestId).toBeNull();
    expect(h.queued).toHaveLength(1);
  });
});

describe("scheduler: one in flight", () => {
  test("mutations during a run mark it dirty instead of queuing a second prompt", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);

    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(60_000);

    expect(h.queued).toHaveLength(1);
    expect((await h.scheduler.status()).dirty).toBe(true);
  });

  test("what landed mid-run is picked up by exactly one follow-up once the run succeeds", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    await h.scheduler.notifyMutation({ needsRoot: true });
    h.answer();

    expect((await h.scheduler.status()).state).toBe("scheduled");
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(2);

    h.answer();
    expect((await h.scheduler.status()).state).toBe("idle");
    await h.advance(300_000);
    expect(h.queued).toHaveLength(2);
  });

  test("a clean run with nothing pending goes back to idle", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    await h.advance(PAST_DEBOUNCE);
    h.answer();

    const status = await h.scheduler.status();
    expect(status.state).toBe("idle");
    expect(status.requestId).toBeNull();
    expect(status.error).toBeNull();
  });
});

describe("scheduler: nothing without a cause", () => {
  test("status() can settle a run but can never start one", async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) {
      await h.scheduler.status();
      await h.advance(5_000);
    }
    expect(h.queued).toHaveLength(0);
    expect((await h.scheduler.status()).state).toBe("idle");
  });

  test("nothing is queued while the menu-bar app is down", async () => {
    const h = harness();
    h.setTrayAlive(false);

    const status = await h.scheduler.notifyMutation({ needsRoot: true });
    expect(status.state).toBe("idle");
    expect(status.reason).toContain("menu-bar app is not running");

    await h.advance(60_000);
    expect(h.queued).toHaveLength(0);
  });

  test("a tray that dies inside the quiet period stops the request", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    h.setTrayAlive(false);

    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(0);
    expect((await h.scheduler.status()).state).toBe("idle");
  });

  test("nothing is queued while autoApply is off", async () => {
    const h = harness();
    h.scheduler.setEnabled(false);

    const status = await h.scheduler.notifyMutation({ needsRoot: true });
    expect(status.state).toBe("idle");
    expect(status.enabled).toBe(false);

    await h.advance(60_000);
    expect(h.queued).toHaveLength(0);
  });

  test("turning autoApply off closes a window that was already open", async () => {
    const h = harness();
    await h.scheduler.notifyMutation({ needsRoot: true });
    expect((await h.scheduler.status()).state).toBe("scheduled");

    h.scheduler.setEnabled(false);
    await h.advance(60_000);
    expect(h.queued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The service layer, which is what actually decides "this needs root"
// ---------------------------------------------------------------------------

describe("service: mutations", () => {
  test("adding an alias schedules one apply and prompts once", async () => {
    const h = harness();
    const { alias, autoApply } = await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));

    expect(alias.hostname).toBe("shop.test");
    expect(autoApply.state).toBe("scheduled");
    expect(h.queued).toHaveLength(0);

    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);
  });

  test("three aliases added in quick succession are ONE prompt", async () => {
    const h = harness();
    await createAliasAndSync({ name: "one", port: 3001 }, opts(h));
    await h.advance(400);
    await createAliasAndSync({ name: "two", port: 3002 }, opts(h));
    await h.advance(400);
    await createAliasAndSync({ name: "three", port: 3003 }, opts(h));

    expect(h.queued).toHaveLength(0);
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);

    await h.advance(120_000);
    expect(h.queued).toHaveLength(1);
  });

  test("deleting an alias schedules an apply", async () => {
    const h = harness();
    const { alias } = await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    h.answer();
    await getState(opts(h));

    const { autoApply } = await deleteAliasAndSync(alias.id, opts(h));
    expect(autoApply.state).toBe("scheduled");
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(2);
  });

  test("changing only the target port queues NOTHING", async () => {
    const h = harness();
    // Get to a machine where everything is already applied, so the only drift the diff can
    // see afterwards is the one this test creates.
    const { alias } = await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    const applied = appliedProbes(buildDesiredState(await loadConfig()));
    h.answer();
    expect((await getState(opts(h, applied))).autoApply.state).toBe("idle");
    const promptsSoFar = h.queued.length;

    const { sync: report, autoApply } = await updateAliasAndSync(
      alias.id,
      { port: 4100 },
      opts(h, applied),
    );

    expect(report.needsPrompt).toBe(false);
    expect(report.unprivileged.join(" ")).toContain("now targets port 4100");
    expect(autoApply.state).toBe("idle");

    await h.advance(120_000);
    // Not one extra prompt: writing routes.json already made the new port live.
    expect(h.queued).toHaveLength(promptsSoFar);

    // routes.json is what the forwarder watches, and it already says 4100.
    const routes = JSON.parse(await readFile(join(box.configDir, "routes.json"), "utf8")) as Array<{
      hostname: string;
      targetPort: number;
    }>;
    expect(routes.find((r) => r.hostname === "shop.test")?.targetPort).toBe(4100);
  });

  test("renaming an alias does need root, and schedules", async () => {
    const h = harness();
    const { alias } = await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    const applied = appliedProbes(buildDesiredState(await loadConfig()));
    await h.advance(PAST_DEBOUNCE);
    h.answer();
    await getState(opts(h, applied));

    const { autoApply } = await updateAliasAndSync(alias.id, { name: "store" }, opts(h, applied));
    expect(autoApply.state).toBe("scheduled");
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(2);
  });

  test("a second mutation while an apply is in flight does not create a second request", async () => {
    const h = harness();
    await createAliasAndSync({ name: "one", port: 3001 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);

    const { autoApply } = await createAliasAndSync({ name: "two", port: 3002 }, opts(h));
    expect(autoApply.state).toBe("prompting");
    expect(autoApply.dirty).toBe(true);

    await h.advance(60_000);
    expect(h.queued).toHaveLength(1);
  });
});

describe("service: cancel", () => {
  test("dismissing the prompt keeps the alias, defers, and never re-prompts", async () => {
    const h = harness();
    await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: true, error: null });

    const state = await getState(opts(h));
    expect(state.autoApply.state).toBe("deferred");
    // Rule: config is persisted BEFORE any apply is considered.
    expect(state.config.aliases.map((a) => a.name)).toEqual(["index", "shop"]);
    expect(JSON.parse(await readFile(join(box.configDir, "config.json"), "utf8")).aliases).toHaveLength(2);

    for (let i = 0; i < 30; i++) {
      await h.advance(10_000);
      await getStatus(opts(h));
    }
    expect(h.queued).toHaveLength(1);
  });

  test("a mutation after a cancel queues again", async () => {
    const h = harness();
    await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: true, error: null });
    expect((await getState(opts(h))).autoApply.state).toBe("deferred");

    await createAliasAndSync({ name: "blog", port: 3100 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(2);
  });

  test("a failed apply keeps the alias and surfaces the real error", async () => {
    const h = harness();
    await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: false, error: "/etc/hosts is read-only" });

    const state = await getState(opts(h));
    expect(state.autoApply.state).toBe("failed");
    expect(state.autoApply.error).toBe("/etc/hosts is read-only");
    expect(state.config.aliases).toHaveLength(2);
  });
});

describe("service: nothing without a user-initiated cause", () => {
  test("polling a drifted machine never queues", async () => {
    const h = harness();
    // Nothing applied at all: exactly what a reboot leaves behind.
    for (let i = 0; i < 25; i++) {
      const state = await getState(opts(h));
      expect(state.sync.needsPrompt).toBe(true);
      await h.advance(5_000);
    }
    expect(h.queued).toHaveLength(0);
  });

  test("polling after a mutation has been applied never queues", async () => {
    const h = harness();
    await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    h.answer();
    const applied = appliedProbes(buildDesiredState(await loadConfig()));

    for (let i = 0; i < 25; i++) {
      await getStatus(opts(h, applied));
      await h.advance(5_000);
    }
    expect(h.queued).toHaveLength(1);
  });

  test("a mutation flagged as not user-initiated never queues", async () => {
    const h = harness();
    const { autoApply } = await updateSettingsAndSync(
      { dashboardPort: 7999 },
      { ...opts(h), userInitiated: false },
    );

    expect(autoApply.state).toBe("idle");
    await h.advance(120_000);
    expect(h.queued).toHaveLength(0);
  });

  test("startup port reconciliation writes no request file at all", async () => {
    process.env.LA_DASHBOARD_PORT = "7999";
    try {
      await reconcileDashboardPort();
      expect((await loadConfig()).dashboardPort).toBe(7999);
      // The real channel, not a stub: if startup could prompt, this file would exist.
      await expect(readFile(applyRequestPath(), "utf8")).rejects.toThrow();
    } finally {
      delete process.env.LA_DASHBOARD_PORT;
    }
  });

  test("nothing is queued when the tray is dead", async () => {
    const h = harness();
    h.setTrayAlive(false);

    const { autoApply } = await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    expect(autoApply.state).toBe("idle");
    expect(autoApply.reason).toContain("menu-bar app is not running");

    await h.advance(120_000);
    expect(h.queued).toHaveLength(0);
    // The alias is saved regardless. Only the applying waits.
    expect((await loadConfig()).aliases.map((a) => a.name)).toEqual(["index", "shop"]);
  });
});

describe("service: the autoApply setting", () => {
  test("defaults to true, and a config written without the field reads as true", async () => {
    expect((await loadConfig()).autoApply).toBe(true);
    expect((await getState({ probes: stubProbes(), probeStatuses: false })).config.autoApply).toBe(true);
  });

  test("with autoApply off, a mutation queues nothing", async () => {
    const h = harness();
    await updateSettings({ autoApply: false });

    const { autoApply } = await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    expect(autoApply.enabled).toBe(false);
    expect(autoApply.state).toBe("idle");

    await h.advance(120_000);
    expect(h.queued).toHaveLength(0);
  });

  test("turning it back on does not retroactively prompt; the next mutation does", async () => {
    const h = harness();
    await updateSettings({ autoApply: false });
    await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(0);

    await updateSettingsAndSync({ autoApply: true }, opts(h));
    // Flipping the setting is itself a mutation with privileged drift outstanding, so it
    // schedules — but only because the user just acted.
    await h.advance(PAST_DEBOUNCE);
    expect(h.queued).toHaveLength(1);
  });

  test("the setting round-trips through the settings endpoint", async () => {
    const h = harness();
    const off = await updateSettingsAndSync({ autoApply: false }, opts(h));
    expect(off.config.autoApply).toBe(false);
    expect(off.autoApply.enabled).toBe(false);

    const on = await updateSettingsAndSync({ autoApply: true }, opts(h));
    expect(on.config.autoApply).toBe(true);

    const stored = JSON.parse(await readFile(join(box.configDir, "config.json"), "utf8")) as Config;
    expect(stored.autoApply).toBe(true);
  });
});

describe("service: state is exposed honestly", () => {
  test("every auto-apply state reaches the state endpoint", async () => {
    const h = harness();
    expect((await getState(opts(h))).autoApply.state).toBe("idle");

    await createAliasAndSync({ name: "shop", port: 3000 }, opts(h));
    expect((await getState(opts(h))).autoApply.state).toBe("scheduled");

    await h.advance(PAST_DEBOUNCE);
    const prompting = (await getState(opts(h))).autoApply;
    expect(prompting.state).toBe("prompting");
    expect(prompting.requestId).toBe("request-1");

    h.answer({ ok: false, cancelled: true, error: null });
    expect((await getState(opts(h))).autoApply.state).toBe("deferred");

    await createAliasAndSync({ name: "blog", port: 3100 }, opts(h));
    await h.advance(PAST_DEBOUNCE);
    h.answer({ ok: false, cancelled: false, error: "boom" });
    const failed = (await getStatus(opts(h))).autoApply;
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("boom");
  });
});
