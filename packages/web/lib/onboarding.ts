/**
 * First-run state.
 *
 * Kept in its own small file next to the config rather than inside `Config`: it is not a
 * setting, nobody edits it, and adding a field to the frozen `Config` type would ripple
 * through the helper, the MCP server and 600-odd tests for something that means "the user
 * has seen the intro".
 *
 * The rule this file encodes: onboarding is shown when the machine is genuinely not set up
 * *and* the user has not already answered the question. Dismissing it is permanent until
 * Settings resets it, so the dashboard can never trap someone in a wizard.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  caExists,
  configDir,
  helperAvailability,
  helperInstallMethod,
  type HelperInstallMethod,
} from "@localhost-aliases/core";

const MARKER = "onboarding.json";

function markerPath(): string {
  return join(configDir(), MARKER);
}

export interface OnboardingRecord {
  completedAt: string | null;
  skippedAt: string | null;
}

export type OnboardingAction = "complete" | "skip" | "reset";

export interface OnboardingState extends OnboardingRecord {
  /** Show the flow now: nothing is set up and the user has not dismissed it. */
  required: boolean;
  /** True once the user has either finished or skipped the flow at least once. */
  answered: boolean;
  /** Why it is required. Keychain trust is not in here: only a live check can tell. */
  missing: { helper: boolean; ca: boolean };
  /** Drives the wording of the helper step — see docs/PHASE4.md §2. */
  installMethod: HelperInstallMethod;
}

async function readRecord(): Promise<OnboardingRecord> {
  const empty: OnboardingRecord = { completedAt: null, skippedAt: null };
  try {
    const raw = (await Bun.file(markerPath()).json()) as Partial<OnboardingRecord>;
    return {
      completedAt: typeof raw?.completedAt === "string" ? raw.completedAt : null,
      skippedAt: typeof raw?.skippedAt === "string" ? raw.skippedAt : null,
    };
  } catch {
    // Missing or unreadable both mean "never answered" — this file is never critical.
    return empty;
  }
}

async function writeRecord(record: OnboardingRecord): Promise<void> {
  await Bun.write(markerPath(), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The full first-run picture. Reads the helper and the CA, so it is a few milliseconds and
 * one socket probe — the same cost `/api/status` already pays.
 */
export async function getOnboarding(): Promise<OnboardingState> {
  const record = await readRecord();
  const availability = await helperAvailability();
  const ca = caExists();

  const missing = { helper: !availability.running, ca: !ca };
  const answered = record.completedAt !== null || record.skippedAt !== null;

  return {
    ...record,
    answered,
    // A machine that already routes traffic and has a CA is set up; anyone else has not
    // finished. Answering the question once — either way — settles it for good.
    required: !answered && (missing.helper || missing.ca),
    missing,
    installMethod: helperInstallMethod(),
  };
}

export async function markOnboarding(action: OnboardingAction): Promise<OnboardingState> {
  const now = new Date().toISOString();
  if (action === "reset") {
    await rm(markerPath(), { force: true });
  } else if (action === "complete") {
    await writeRecord({ completedAt: now, skippedAt: null });
  } else {
    await writeRecord({ completedAt: null, skippedAt: now });
  }
  return await getOnboarding();
}
