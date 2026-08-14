/**
 * The auto-apply reading: what the service layer's debounce/queue is doing right now.
 *
 * It rides the same polled snapshot as every other reading — there is exactly one timer
 * in this app and this file does not add a second one. The field is read defensively
 * from either the snapshot root or the sync report, because *where* the service layer
 * publishes it is its own business and no screen should break over the choice. Anything
 * missing or unrecognised reads as `idle`, and `idle` is byte-for-byte today's manual UI.
 *
 * Every sentence here is a claim about the user's Mac, so none of them may run ahead of
 * the machine: "applying" never means "applied", and only `failed` ever carries an
 * error — the real one, never a generic stand-in.
 */
import type { Config } from "@localhost-aliases/core/types";
import type { StatusState } from "../../lib/client/status-store.ts";
import type { Reading } from "./status-read.ts";

export type AutoApplyPhase = "idle" | "scheduled" | "prompting" | "deferred" | "failed";

export interface AutoApply {
  phase: AutoApplyPhase;
  /** The privileged run's own error text. Null unless `failed`. */
  error: string | null;
  /** The service layer's plain-language explanation, when it offers one. */
  reason: string | null;
}

export const AUTO_APPLY_IDLE: AutoApply = { phase: "idle", error: null, reason: null };

const PHASES = new Set<string>(["idle", "scheduled", "prompting", "deferred", "failed"]);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** Accepts a bare phase string, or the service layer's status object (`state` or `phase`). */
function coerce(value: unknown): AutoApply | null {
  if (typeof value === "string") {
    return PHASES.has(value) ? { phase: value as AutoApplyPhase, error: null, reason: null } : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { phase?: unknown; state?: unknown; error?: unknown; reason?: unknown };
  const phase = typeof raw.phase === "string" ? raw.phase : raw.state;
  if (typeof phase !== "string" || !PHASES.has(phase)) return null;
  return {
    phase: phase as AutoApplyPhase,
    // Only a failure carries an error; a stale one on any other state would be a lie.
    error: phase === "failed" ? text(raw.error) : null,
    reason: text(raw.reason),
  };
}

export function readAutoApply(state: StatusState): AutoApply {
  if (!state.loaded) return AUTO_APPLY_IDLE;
  const root = (state as { autoApply?: unknown }).autoApply;
  const nested = (state.sync as { autoApply?: unknown } | null)?.autoApply;
  return coerce(root) ?? coerce(nested) ?? AUTO_APPLY_IDLE;
}

/**
 * The setting, not the state. Default true — docs/AUTOAPPLY.md. A config written before
 * the field existed carries no value at all, and a missing field is not `false`.
 */
export function autoApplyEnabled(config: Config | null): boolean {
  return typeof config?.autoApply === "boolean" ? config.autoApply : true;
}

export interface ApplyReading extends Reading {
  phase: AutoApplyPhase;
  /** Nothing re-prompts on its own, so these two states need a button. */
  retryable: boolean;
}

/**
 * Null while idle: the gauge only exists when there is something to report. A permanent
 * "auto-apply: idle" lamp would be three words of chrome saying nothing happened.
 */
export function readApply(auto: AutoApply): ApplyReading | null {
  switch (auto.phase) {
    case "scheduled":
      return {
        phase: "scheduled",
        tone: "down",
        value: "in a moment",
        note: "Applying in a moment. Your change is already saved; the menu-bar app raises one admin prompt covering everything pending, so three changes in a row still cost one password.",
        retryable: false,
      };
    case "prompting":
      return {
        phase: "prompting",
        tone: "down",
        value: "waiting",
        note: "Waiting for your password. The menu-bar app has raised the admin prompt — approve it and these names start resolving. Until then nothing on this Mac has changed.",
        retryable: false,
      };
    case "deferred":
      return {
        phase: "deferred",
        tone: "down",
        value: "deferred",
        note: "You dismissed the prompt. Your aliases are saved, nothing on this Mac changed, and nothing will ask again on its own — try again when you are ready.",
        retryable: true,
      };
    case "failed":
      return {
        phase: "failed",
        tone: "down",
        value: "failed",
        note:
          auto.error ??
          auto.reason ??
          "The apply failed and reported no reason. Your aliases are saved; nothing on this Mac changed.",
        retryable: true,
      };
    default:
      return null;
  }
}
