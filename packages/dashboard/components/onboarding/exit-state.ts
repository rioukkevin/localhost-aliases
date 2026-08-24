/**
 * The end-of-flow exit: what the one button says, and whether leaving has to be
 * recorded as a skip.
 *
 * Pure on purpose. The gate in components/shell/useSetupGate.ts sends anyone back to
 * /onboarding unless the record says `complete` or `skipped`, so a button that only
 * navigated would bounce straight back. When the required steps are not done, leaving
 * is a real decision and is recorded through the existing "skip" action — there is no
 * second flag anywhere.
 *
 * The copy is not allowed to be vague: if the machine was never applied, the names do
 * not resolve, and the button says so in those words.
 */
import type { OnboardingStep, OnboardingStepId } from "@localhost-aliases/core/types";

/** Mirrors REQUIRED_STEPS in lib/onboarding.ts: https and mcp are optional. */
const REQUIRED: readonly OnboardingStepId[] = ["explain", "apply", "verify"];

export interface ExitPlan {
  /** true → run the "skip" action before leaving, or the gate sends the user back. */
  recordSkip: boolean;
  label: string;
  /** Spoken label: the short visible one plus the state it is leaving. */
  ariaLabel: string;
  /** The one-line verdict above the button. */
  headline: string;
  /** What is not set up and what that costs, one plain line each. Empty when done. */
  missing: string[];
  /** What leaving does, and where setup is picked up again. */
  note: string;
}

function stateOf(steps: OnboardingStep[], id: OnboardingStepId): OnboardingStep["state"] {
  return steps.find((s) => s.id === id)?.state ?? "pending";
}

/**
 * Consequences, hardest first: the apply step is the one whose absence a user will
 * actually notice, so it leads the sentence and the aria-label.
 */
function missingFrom(steps: OnboardingStep[], verifyUrl: string): string[] {
  const lines: string[] = [];
  if (stateOf(steps, "apply") !== "done") {
    lines.push(
      "the /etc/hosts entries, the loopback addresses and the forwarder were never applied, " +
        `so your alias names do not resolve yet: ${verifyUrl} will not answer`,
    );
  } else if (stateOf(steps, "verify") === "failed") {
    lines.push(`the last check of ${verifyUrl} did not get an answer back`);
  } else if (stateOf(steps, "verify") !== "done") {
    lines.push(`nothing has checked that ${verifyUrl} really answers yet`);
  }
  if (stateOf(steps, "explain") !== "done") {
    lines.push("the list of what setup changes on this Mac was never read");
  }
  return lines;
}

/**
 * The gate's own question, negated. components/shell/useSetupGate.ts redirects unless the
 * record says `complete || skipped`, so leaving has to record the skip in exactly the
 * cases where neither holds — and it must be asked of the record the server just handed
 * back, never of whatever the screen happens to be showing.
 */
export function needsSkipRecorded(state: { complete: boolean; skipped: boolean }): boolean {
  return !state.complete && !state.skipped;
}

/**
 * Before the first read of /api/onboarding lands, nothing is known about this machine —
 * so nothing is claimed. The way out is still there; it just does not pretend to know
 * whether /etc/hosts was ever touched. `recordSkip` is the safe half of the guess, and
 * OnboardingFlow re-checks it against the record before it writes anything.
 */
export const UNKNOWN_PLAN: ExitPlan = {
  recordSkip: true,
  label: "Open the dashboard",
  ariaLabel: "Open the dashboard — still reading the setup state",
  headline: "Still reading the setup state.",
  missing: [],
  note: "Leaving stops setup exactly where it is and changes nothing on this Mac. Pick it up again from Settings → setup.",
};

export function exitPlan(
  steps: OnboardingStep[],
  verifyUrl: string,
  complete = REQUIRED.every((id) => stateOf(steps, id) === "done"),
): ExitPlan {
  if (complete) {
    return {
      recordSkip: false,
      label: "Open the dashboard",
      ariaLabel: "Open the dashboard — setup is complete",
      headline: "Setup is finished: your names resolve, and one of them really answered.",
      missing: [],
      note: "Re-run it any time from Settings → setup; it is idempotent, so running it again changes nothing.",
    };
  }

  const missing = missingFrom(steps, verifyUrl);
  return {
    recordSkip: true,
    label: "Open the dashboard anyway",
    ariaLabel: `Open the dashboard anyway — setup is unfinished: ${missing[0] ?? "steps remain"}`,
    headline: "Setup is not finished. Leaving now means:",
    missing,
    note:
      "Nothing is half-written — leaving stops setup exactly where it is and changes nothing on " +
      "this Mac. Pick it up again from Settings → setup.",
  };
}
