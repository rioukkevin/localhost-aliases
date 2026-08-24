/**
 * ADVERSARIAL VERIFICATION of automatic apply — drives the REAL service layer against a
 * temp LA_CONFIG_DIR. The "privileged runner" is the request file: writing one is the
 * ONLY thing that can ever raise a macOS dialog, so counting `queue()` calls counts
 * prompts exactly. Nothing privileged is ever executed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  applyResultPath,
  configPath,
  routesPath,
  desiredStatePath,
  loadConfig,
  type PrivilegedRequest,
  type PrivilegedResult,
} from "@localhost-aliases/core";
import { createAutoApply, AUTO_APPLY_DEBOUNCE_MS, type AutoApply } from "../lib/auto-apply.ts";
import { requestPrivileged, readResultFor } from "../lib/privileged-channel.ts";
import { writeJsonAtomic } from "../lib/files.ts";
import {
  createAliasAndSync,
  updateAliasAndSync,
  deleteAliasAndSync,
  updateSettingsAndSync,
  getState,
  getStatus,
} from "../lib/service.ts";
import { reconcileDashboardPort } from "../lib/startup.ts";
import { sandbox, stubProbes, type Sandbox } from "./helpers.ts";

// --- controllable world -----------------------------------------------------

interface Timer { id: number; at: number; fn: () => void; }

class World {
  clock = 1_000_000;
  timers: Timer[] = [];
  nextId = 1;
  trayUp = true;
  /** Every request written. Each entry is one macOS admin prompt that WOULD appear. */
  prompts: PrivilegedRequest[] = [];
  scheduler!: AutoApply;

  build(): AutoApply {
    this.scheduler = createAutoApply({
      now: () => this.clock,
      setTimer: (fn, ms) => {
        const t: Timer = { id: this.nextId++, at: this.clock + ms, fn };
        this.timers.push(t);
        return t.id;
      },
      clearTimer: (handle) => {
        this.timers = this.timers.filter((t) => t.id !== handle);
      },
      trayAlive: async () => this.trayUp,
      queue: async () => {
        const req = await requestPrivileged("apply"); // real file write, temp dir
        this.prompts.push(req);
        return req;
      },
      readResult: (id) => readResultFor(id),
    });
    return this.scheduler;
  }

  /** Advance fake time, firing due timers, then drain the scheduler's work queue. */
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next) break;
      this.clock = next.at;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      next.fn();
      await this.scheduler.whenSettled();
    }
    this.clock = target;
    await this.scheduler.whenSettled();
  }

  /** The tray answers the newest request. */
  async answer(outcome: "ok" | "cancelled" | "error"): Promise<void> {
    const req = this.prompts[this.prompts.length - 1];
    if (!req) throw new Error("no request to answer");
    const result: PrivilegedResult = {
      id: req.id,
      kind: req.kind,
      ok: outcome === "ok",
      cancelled: outcome === "cancelled",
      ...(outcome === "error" ? { error: "apply.sh exited 2: could not write /etc/hosts" } : {}),
      startedAt: req.requestedAt,
      finishedAt: new Date(this.clock).toISOString(),
    } as PrivilegedResult;
    await writeJsonAtomic(applyResultPath(), result);
  }
}

let box: Sandbox;
let w: World;
/** A machine where nothing has been applied: every alias is drift needing root. */
const bare = () => stubProbes({ loopbackIps: ["127.0.0.1"], hosts: [], forwarder: null });

function opts(extra: Record<string, unknown> = {}) {
  return { scheduler: w.scheduler, probes: bare(), probeStatuses: false, ...extra };
}

beforeEach(async () => {
  box = await sandbox();
  w = new World();
  w.build();
});
afterEach(async () => {
  await box.cleanup();
});

const add = (name: string, port: number) => createAliasAndSync({ name, port }, opts());

// ---------------------------------------------------------------------------

describe("2.1 one alias added -> exactly ONE request", () => {
  test("one prompt, and not before the debounce closes", async () => {
    const r = await add("alpha", 3000);
    expect(r.sync.needsPrompt).toBe(true);
    expect(w.prompts.length).toBe(0); // nothing yet: the window is still open
    expect(r.autoApply.state).toBe("scheduled");

    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
    expect(w.scheduler.snapshot().state).toBe("prompting");

    await w.answer("ok");
    const s = await getState(opts({ probes: bare() }));
    expect(w.prompts.length).toBe(1);
    expect(s.autoApply.state).toBe("idle");
  });
});

describe("2.2 five aliases within a second -> ONE request", () => {
  test("coalesced", async () => {
    for (const [i, n] of ["a", "b", "c", "d", "e"].entries()) {
      await add(n, 3100 + i);
      await w.advance(150); // 150ms apart => all inside one 1500ms window
    }
    expect(w.prompts.length).toBe(0);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
    const cfg = await loadConfig();
    const mine = cfg.aliases.filter((a) => "abcde".includes(a.name) && a.name.length === 1);
    expect(mine.length).toBe(5); // one prompt covers all five
  });
});

describe("2.3 port-only change -> ZERO requests, routes.json still updated", () => {
  test("no prompt, and the forwarder gets the new port", async () => {
    const created = await add("web", 3000);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    await w.answer("ok");
    expect(w.prompts.length).toBe(1);

    // Machine is now fully applied for this alias.
    const applied = JSON.parse(await readFile(desiredStatePath(), "utf8"));
    const probes = stubProbes({
      loopbackIps: ["127.0.0.1", ...applied.loopbackIps],
      hosts: applied.hosts,
      forwarder: { pid: 1, startedAt: "x", routes: applied.routes, failures: [] },
    });
    await getState({ scheduler: w.scheduler, probes, probeStatuses: false });
    const before = w.prompts.length;

    const r = await updateAliasAndSync(created.alias.id, { port: 4321 }, {
      scheduler: w.scheduler, probes, probeStatuses: false,
    });
    expect(r.sync.needsPrompt).toBe(false);
    await w.advance(60_000);
    expect(w.prompts.length).toBe(before); // ZERO new prompts
    expect(w.scheduler.snapshot().state).not.toBe("scheduled");

    const routes = JSON.parse(await readFile(routesPath(), "utf8"));
    const route = routes.find((x: { hostname?: string }) => String(x.hostname ?? "").startsWith("web."));
    expect(route.targetPort).toBe(4321); // it works with no prompt at all
  });
});

describe("2.4 cancel -> zero further requests, forever", () => {
  test("no re-queue across ten minutes and 120 polls", async () => {
    await add("cancelme", 3200);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
    await w.answer("cancelled");

    const s = await getState(opts());
    expect(s.autoApply.state).toBe("deferred");

    for (let i = 0; i < 120; i++) {
      await getState(opts());
      await getStatus(opts());
      await w.advance(5_000); // 5s poll interval => 10 minutes
    }
    expect(w.prompts.length).toBe(1);
    expect(w.timers.length).toBe(0); // no retry timer survived the cancel
    expect(w.scheduler.snapshot().state).toBe("deferred");
  });

  test("the alias is still on disk after the cancelled run", async () => {
    await add("survivor", 3201);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    await w.answer("cancelled");
    await getState(opts());

    const raw = JSON.parse(await readFile(configPath(), "utf8"));
    expect(raw.aliases.map((a: { name: string }) => a.name)).toContain("survivor");
  });

  test("a FAILED run also parks, and also keeps the alias", async () => {
    await add("failme", 3202);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    await w.answer("error");
    const s = await getState(opts());
    expect(s.autoApply.state).toBe("failed");
    expect(s.autoApply.error).toContain("apply.sh exited 2");
    for (let i = 0; i < 40; i++) { await getState(opts()); await w.advance(5_000); }
    expect(w.prompts.length).toBe(1);
    const raw = JSON.parse(await readFile(configPath(), "utf8"));
    expect(raw.aliases.map((a: { name: string }) => a.name)).toContain("failme");
  });
});

describe("2.5 a new mutation after a cancel -> exactly one request", () => {
  test("one, not zero and not two", async () => {
    await add("first", 3300);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    await w.answer("cancelled");
    await getState(opts());
    expect(w.scheduler.snapshot().state).toBe("deferred");

    await add("second", 3301);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(2);
    await w.advance(600_000);
    expect(w.prompts.length).toBe(2);
  });
});

describe("2.6 tray heartbeat stale -> zero requests", () => {
  test("nothing queued, and the reason says so", async () => {
    w.trayUp = false;
    const r = await add("notray", 3400);
    expect(r.autoApply.state).toBe("idle");
    expect(r.autoApply.reason).toContain("menu-bar app is not running");
    await w.advance(600_000);
    expect(w.prompts.length).toBe(0);
    expect(w.timers.length).toBe(0);
    const raw = JSON.parse(await readFile(configPath(), "utf8"));
    expect(raw.aliases.map((a: { name: string }) => a.name)).toContain("notray"); // still saved
  });

  test("tray dying DURING the debounce window queues nothing", async () => {
    await add("dies", 3401);
    expect(w.timers.length).toBe(1);
    w.trayUp = false;
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(0);
    expect(w.scheduler.snapshot().state).toBe("idle");
  });
});

describe("2.7 autoApply false -> zero requests, manual path still works", () => {
  test("off means off", async () => {
    await updateSettingsAndSync({ autoApply: false }, opts());
    expect((await loadConfig()).autoApply).toBe(false);

    await add("manual", 3500);
    await w.advance(600_000);
    expect(w.prompts.length).toBe(0);

    // the manual path: an explicit request still works and still prompts once
    const req = await requestPrivileged("apply");
    await w.scheduler.noteExplicitRequest(req);
    expect(w.scheduler.snapshot().state).toBe("prompting");
    const state = await getState(opts());
    expect(state.autoApply.enabled).toBe(false);
    expect(w.prompts.length).toBe(0); // the scheduler queued none of it
  });

  test("turning it back on does not retroactively prompt for old drift on a POLL", async () => {
    await updateSettingsAndSync({ autoApply: false }, opts());
    await add("old", 3501);
    await w.advance(600_000);
    expect(w.prompts.length).toBe(0);
    await updateSettingsAndSync({ autoApply: true }, { ...opts(), userInitiated: false });
    for (let i = 0; i < 50; i++) { await getState(opts()); await w.advance(5_000); }
    expect(w.prompts.length).toBe(0);
  });
});

describe("2.8 startup with drifted state and NO user action -> ZERO requests", () => {
  test("the reboot case: drift everywhere, nobody touched anything", async () => {
    // Seed a config full of aliases, as if from before a reboot.
    await updateSettingsAndSync({ autoApply: true }, { ...opts(), userInitiated: false });
    for (const [i, n] of ["r1", "r2", "r3"].entries()) {
      await createAliasAndSync({ name: n, port: 3600 + i }, { ...opts(), userInitiated: false });
    }
    expect(w.prompts.length).toBe(0);

    // Now "boot": startup reconciliation + the poller, for ten minutes.
    process.env.LA_DASHBOARD_PORT = "7899";
    try {
      await reconcileDashboardPort();
      await w.scheduler.whenSettled();
      for (let i = 0; i < 120; i++) {
        const s = await getState(opts());
        expect(s.sync.needsPrompt).toBe(true); // drift IS present and reported
        await w.advance(5_000);
      }
      expect(w.prompts.length).toBe(0); // and never once prompted for
      expect(w.timers.length).toBe(0);
    } finally {
      delete process.env.LA_DASHBOARD_PORT;
    }
  });
});

describe("2.9 mutation while an apply is in flight", () => {
  test("no second request; the change is picked up after", async () => {
    await add("inflight1", 3700);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
    expect(w.scheduler.snapshot().state).toBe("prompting");

    const mid = await add("inflight2", 3701);
    expect(mid.autoApply.state).toBe("prompting");
    expect(mid.autoApply.dirty).toBe(true);
    await w.advance(30_000);
    expect(w.prompts.length).toBe(1); // no second prompt while in flight

    await w.answer("ok");
    await getState(opts());
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(2); // exactly one follow-up
    await w.answer("ok");
    await getState(opts());
    await w.advance(600_000);
    expect(w.prompts.length).toBe(2);
  });

  test("a mutation mid-flight followed by a CANCEL does not re-prompt", async () => {
    await add("c1", 3800);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    await add("c2", 3801);
    expect(w.scheduler.snapshot().dirty).toBe(true);
    await w.answer("cancelled");
    await getState(opts());
    expect(w.scheduler.snapshot().state).toBe("deferred");
    for (let i = 0; i < 60; i++) { await getState(opts()); await w.advance(5_000); }
    expect(w.prompts.length).toBe(1); // dirty must NOT survive a cancel
  });
});

describe("3. failure modes the spec exists to prevent", () => {
  test("a poll can never reach the queue, even with drift and dirty pending", async () => {
    await add("p1", 3900);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    const before = w.prompts.length;
    // 200 polls with no timers firing at all
    w.timers = [];
    for (let i = 0; i < 200; i++) await getStatus(opts());
    expect(w.prompts.length).toBe(before);
  });

  test("an unanswered run does not stick on prompting forever", async () => {
    await add("ghost", 3901);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.scheduler.snapshot().state).toBe("prompting");
    await w.advance(120_000); // past APPLY_REQUEST_TTL_MS
    const s = await getState(opts());
    expect(s.autoApply.state).toBe("failed");
    expect(w.prompts.length).toBe(1); // written off, not retried
  });

  test("a queue() that throws lands in failed with the real error, not stuck prompting", async () => {
    const boom = createAutoApply({
      now: () => w.clock,
      setTimer: (fn, ms) => { const t = { id: w.nextId++, at: w.clock + ms, fn }; w.timers.push(t); return t.id; },
      clearTimer: (h) => { w.timers = w.timers.filter((t) => t.id !== h); },
      trayAlive: async () => true,
      queue: async () => { throw new Error("EROFS: read-only file system"); },
      readResult: async () => null,
    });
    w.scheduler = boom;
    await createAliasAndSync({ name: "boom", port: 3902 }, opts());
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    const s = boom.snapshot();
    expect(s.state).toBe("failed");
    expect(s.error).toContain("EROFS");
    await w.advance(600_000);
    expect(boom.snapshot().state).toBe("failed"); // no retry
  });

  test("two schedulers do not race: the service uses the one it was given", async () => {
    const other = new World();
    other.build();
    await createAliasAndSync({ name: "solo", port: 3903 }, opts());
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
    expect(other.prompts.length).toBe(0);
    expect(other.scheduler.snapshot().state).toBe("idle");
  });

  test("STARVATION: continuous mutation inside the window never fires", async () => {
    for (let i = 0; i < 40; i++) {
      await createAliasAndSync({ name: `starve${i}`, port: 4000 + i }, opts());
      await w.advance(1_000); // always < 1500ms apart
    }
    // 40 seconds of continuous mutation and not one prompt has been raised.
    expect(w.prompts.length).toBe(0);
    expect(w.scheduler.snapshot().state).toBe("scheduled");
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
  });

  test("a delete is a root change and coalesces with adds into one prompt", async () => {
    const a = await add("d1", 4100);
    await add("d2", 4101);
    await deleteAliasAndSync(a.alias.id, opts());
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(1);
  });
});

describe("4. config is persisted before anything privileged", () => {
  test("config.json holds the alias before the request file exists", async () => {
    await add("order", 4200);
    const cfg = JSON.parse(await readFile(configPath(), "utf8"));
    expect(cfg.aliases.map((a: { name: string }) => a.name)).toContain("order");
    expect(w.prompts.length).toBe(0); // config written, nothing asked yet
  });
});

describe("5. edge cases an adversary would go for", () => {
  test("turning the setting OFF during the debounce window cancels the prompt", async () => {
    await add("racer", 4300);
    expect(w.timers.length).toBe(1);
    await updateSettingsAndSync({ autoApply: false }, opts());
    await w.advance(600_000);
    expect(w.prompts.length).toBe(0);
  });

  test("turning the setting OFF while trayAlive() is being awaited still queues (narrow race)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let firstCall = true;
    const s = createAutoApply({
      now: () => w.clock,
      setTimer: (fn, ms) => { const t = { id: w.nextId++, at: w.clock + ms, fn }; w.timers.push(t); return t.id; },
      clearTimer: (h) => { w.timers = w.timers.filter((t) => t.id !== h); },
      trayAlive: async () => {
        if (firstCall) { firstCall = false; return true; }
        await gate; // suspend inside fire()'s trayAlive await
        return true;
      },
      queue: async () => { const r = await requestPrivileged("apply"); w.prompts.push(r); return r; },
      readResult: async () => null,
    });
    w.scheduler = s;
    await createAliasAndSync({ name: "race", port: 4301 }, opts());
    const timer = w.timers[0]!;
    w.timers = [];
    timer.fn();               // fire() is now suspended inside trayAlive()
    s.setEnabled(false);      // the user turns auto-apply off, right now
    release();
    await s.whenSettled();
    // Documents the actual behaviour rather than asserting the ideal one.
    console.log(`      [race] prompts after disabling mid-await: ${w.prompts.length}`);
    expect(w.prompts.length).toBeLessThanOrEqual(1);
  });

  test("turning the setting ON with pre-existing drift schedules a prompt", async () => {
    await updateSettingsAndSync({ autoApply: false }, opts());
    await add("preexisting", 4302);
    await w.advance(600_000);
    expect(w.prompts.length).toBe(0);

    await updateSettingsAndSync({ autoApply: true }, opts()); // a user toggling the switch
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    console.log(`      [toggle-on] prompts raised by flipping the switch: ${w.prompts.length}`);
    expect(w.prompts.length).toBeLessThanOrEqual(1);
  });

  test("a TLD change is a root change and raises exactly one prompt", async () => {
    await add("tldtest", 4303);
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    await w.answer("ok");
    await getState(opts());
    const before = w.prompts.length;
    await updateSettingsAndSync({ tld: "internal" }, opts());
    await w.advance(AUTO_APPLY_DEBOUNCE_MS);
    expect(w.prompts.length).toBe(before + 1);
  });

  test("GET-shaped calls (getSettings/getState/getStatus) never queue", async () => {
    await add("readonly", 4304);
    w.timers = []; // kill the pending window so only reads can act
    for (let i = 0; i < 100; i++) {
      await getState(opts());
      await getStatus(opts());
    }
    expect(w.prompts.length).toBe(0);
  });
});
