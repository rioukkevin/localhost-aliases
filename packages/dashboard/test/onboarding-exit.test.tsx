/**
 * The one way out at the end of setup.
 *
 * Two things must hold, and both are tested against the real lib/onboarding.ts writing
 * into a temp LA_CONFIG_DIR: a complete setup leaves without recording anything, and an
 * unfinished one records the skip so the gate in components/shell/useSetupGate.ts stops
 * sending the user back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDesiredState, loadConfig } from "@localhost-aliases/core";
import type { OnboardingStep, OnboardingStepId } from "@localhost-aliases/core/types";
import { advanceOnboarding, getOnboarding } from "../lib/onboarding.ts";
import { ExitSetup } from "../components/onboarding/ExitSetup.tsx";
import { UNKNOWN_PLAN, exitPlan, needsSkipRecorded } from "../components/onboarding/exit-state.ts";
import { appliedProbes, sandbox, stubProbes, type Sandbox } from "./helpers.ts";

let box: Sandbox;
const bare = { probes: stubProbes(), probeStatuses: false as const };

beforeEach(async () => {
  box = await sandbox();
});
afterEach(() => box.cleanup());

/** Exactly what useSetupGate asks before it redirects. Copied, not imported, on purpose. */
function gatePasses(state: { complete: boolean; skipped: boolean }): boolean {
  return state.complete || state.skipped;
}

function step(id: OnboardingStepId, state: OnboardingStep["state"]): OnboardingStep {
  return { id, title: id, state, detail: null, needsUser: false };
}

const URL = "http://index.test";

describe("exit plan", () => {
  test("a complete setup finishes: no skip is recorded and the label reads as arrival", () => {
    const plan = exitPlan([], URL, true);

    expect(plan.recordSkip).toBe(false);
    expect(plan.label).toBe("Open the dashboard");
    expect(plan.missing).toEqual([]);
    expect(plan.ariaLabel).toContain("setup is complete");
    expect(plan.headline).toContain("Setup is finished");
    expect(plan.note).toContain("Settings");
  });

  test("an unapplied machine is told, in plain words, that names do not resolve", () => {
    const plan = exitPlan(
      [step("explain", "done"), step("apply", "pending"), step("verify", "pending")],
      URL,
    );

    expect(plan.recordSkip).toBe(true);
    expect(plan.label).toBe("Open the dashboard anyway");
    expect(plan.missing).toHaveLength(1);
    expect(plan.missing[0]).toContain("do not resolve");
    expect(plan.missing[0]).toContain("/etc/hosts");
    expect(plan.missing[0]).toContain(URL);
    // No vagueness allowed.
    expect(plan.headline).not.toContain("some steps");
    // The way back is named.
    expect(plan.note).toContain("Settings");
    expect(plan.ariaLabel).toContain("unfinished");
  });

  test("applied but unverified says only that, not that names are broken", () => {
    const plan = exitPlan(
      [step("explain", "done"), step("apply", "done"), step("verify", "pending")],
      URL,
    );

    expect(plan.recordSkip).toBe(true);
    expect(plan.missing).toEqual([`nothing has checked that ${URL} really answers yet`]);
    expect(plan.missing.join(" ")).not.toContain("do not resolve");
  });

  test("a failed verify is reported as the failure it was", () => {
    const plan = exitPlan(
      [step("explain", "done"), step("apply", "done"), step("verify", "failed")],
      URL,
    );

    expect(plan.missing[0]).toContain("did not get an answer back");
  });

  test("the optional steps never make setup unfinished", () => {
    const done = [step("explain", "done"), step("apply", "done"), step("verify", "done")];
    const plan = exitPlan([...done, step("https", "pending"), step("mcp", "pending")], URL);

    expect(plan.recordSkip).toBe(false);
    expect(plan.label).toBe("Open the dashboard");
  });
});

describe("before the first read lands", () => {
  test("claims nothing about a machine it has not looked at yet", () => {
    // The old bug: a finished Mac was told, for as long as the first GET took, that its
    // /etc/hosts entries "were never applied".
    expect(UNKNOWN_PLAN.missing).toEqual([]);
    expect(UNKNOWN_PLAN.headline).not.toContain("not finished");
    expect(UNKNOWN_PLAN.headline).not.toContain("never");
    expect(UNKNOWN_PLAN.note).toContain("Settings");
  });

  test("the way out is still rendered, and still primary", () => {
    const html = renderToStaticMarkup(<ExitSetup plan={UNKNOWN_PLAN} onExit={() => {}} />);

    expect(html).toContain('data-testid="onboarding-exit"');
    expect(html).toContain("bg-accent");
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain("do not resolve");
  });
});

describe("what leaving writes", () => {
  test("is the gate's predicate, negated — asked of the record, not the screen", () => {
    expect(needsSkipRecorded({ complete: false, skipped: false })).toBe(true);
    // A finished setup must never be given a skip it did not ask for.
    expect(needsSkipRecorded({ complete: true, skipped: false })).toBe(false);
    // Already skipped: re-entered from Settings, left again. Nothing to rewrite.
    expect(needsSkipRecorded({ complete: false, skipped: true })).toBe(false);
    expect(needsSkipRecorded({ complete: true, skipped: true })).toBe(false);
  });

  test("agrees with the real record in both directions", async () => {
    const fresh = await getOnboarding(bare);
    expect(needsSkipRecorded(fresh)).toBe(true);

    const skipped = await advanceOnboarding("skip", {}, bare);
    expect(needsSkipRecorded(skipped)).toBe(false);
    expect(gatePasses(skipped)).toBe(true);
  });

  test("the skip is not a reset: per-step progress survives it", async () => {
    await advanceOnboarding("explain", {}, bare);
    const after = await advanceOnboarding("skip", {}, bare);

    expect(after.steps.find((s) => s.id === "explain")?.state).toBe("done");
    const record = JSON.parse(await readFile(join(box.configDir, "onboarding.json"), "utf8"));
    expect(record.steps.explain.state).toBe("done");
    expect(record.skipped).toBe(true);
  });
});

describe("exit control", () => {
  test("renders one primary, always-enabled button carrying the state in its label", () => {
    const html = renderToStaticMarkup(
      <ExitSetup plan={exitPlan([], URL)} onExit={() => {}} />,
    );

    expect(html).toContain('data-testid="onboarding-exit"');
    expect(html).toContain("Open the dashboard anyway");
    expect(html).toContain("bg-accent");
    expect(html).toContain("do not resolve");
    expect(html).toContain('aria-label="Open the dashboard anyway');
    // The aria-label leads with the consequence that bites, not the weakest one.
    expect(html).toContain("unfinished: the /etc/hosts entries");
    // Machine-literal text stays mono, per docs/DESIGN.md.
    expect(html).toContain('class="mono text-ink">http://index.test');
    expect(html).not.toContain("disabled=");
  });

  test("busy is the only thing that can disable it", () => {
    const html = renderToStaticMarkup(
      <ExitSetup plan={exitPlan([], URL, true)} busy onExit={() => {}} />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Open the dashboard");
  });
});

describe("leaving, against the real record", () => {
  test("unfinished: the skip is recorded and the gate stops redirecting", async () => {
    const before = await getOnboarding(bare);
    const plan = exitPlan(before.steps, before.verifyUrl, before.complete);

    expect(plan.recordSkip).toBe(true);
    expect(gatePasses(before)).toBe(false);

    const after = await advanceOnboarding("skip", {}, bare);

    expect(after.skipped).toBe(true);
    expect(after.complete).toBe(false);
    expect(gatePasses(after)).toBe(true);

    const record = JSON.parse(await readFile(join(box.configDir, "onboarding.json"), "utf8"));
    expect(record.skipped).toBe(true);
    // One flag, the one that already existed.
    expect(Object.keys(record).sort()).toEqual(["skipped"]);
  });

  test("complete: the finish label, and nothing is recorded on the way out", async () => {
    const applied = { probes: appliedProbes(buildDesiredState(await loadConfig())), probeStatuses: false as const };
    await advanceOnboarding("explain", {}, applied);

    // runVerify makes one real request through the alias; on a sandboxed machine the
    // name cannot resolve, so the fetch itself is stubbed rather than the result faked.
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response("ok", { status: 200 }), {
      preconnect: () => {},
    }) as unknown as typeof fetch;
    try {
      await advanceOnboarding("verify", {}, applied);
    } finally {
      globalThis.fetch = realFetch;
    }

    const state = await getOnboarding(applied);
    expect(state.complete).toBe(true);
    expect(gatePasses(state)).toBe(true);

    const plan = exitPlan(state.steps, state.verifyUrl, state.complete);
    expect(plan.recordSkip).toBe(false);
    expect(plan.label).toBe("Open the dashboard");

    // Leaving a finished setup writes nothing: the record still says not-skipped.
    const record = JSON.parse(await readFile(join(box.configDir, "onboarding.json"), "utf8"));
    expect(record.skipped).toBeUndefined();
    expect(record.steps.verify.state).toBe("done");
  });
});
