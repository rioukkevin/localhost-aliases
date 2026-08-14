"use client";

/**
 * Per-row honesty: is *this* name actually resolving on this Mac yet?
 *
 * The alias list comes from the config, which is written before any apply — so a row can
 * exist, be perfectly valid, and still resolve to nothing. Live means all three legs of
 * the path are really there, as observed on the machine: the hostname in the managed
 * /etc/hosts block, its loopback address on lo0, and the forwarder actually bound to that
 * address. Two out of three is a name that resolves to somewhere nothing answers.
 *
 * `alias.status` is deliberately not part of it: that probes the dev server's port, which
 * says nothing at all about whether the alias reaches it.
 *
 * `unknown` exists so the first render cannot assert anything: before the machine has
 * answered, "not live" would be a claim about the user's Mac made before asking it.
 */
import type { AliasView, SystemState } from "@localhost-aliases/core/types";
import { isPending } from "../../lib/client/format.ts";
import { useStatus, type StatusState } from "../../lib/client/status-store.ts";
import { readAutoApply, type AutoApply, AUTO_APPLY_IDLE } from "../shell/auto-apply-read.ts";

export type AliasApply =
  | "unknown"
  | "saving"
  | "live"
  | "scheduled"
  | "prompting"
  | "deferred"
  | "failed"
  | "unapplied";

export interface ApplyChip {
  label: string;
  /** The whole sentence, on the chip's tooltip — the row has no space for it. */
  title: string;
}

export function aliasApply(
  alias: AliasView,
  system: SystemState | null,
  auto: AutoApply = AUTO_APPLY_IDLE,
): AliasApply {
  if (isPending(alias)) return "saving";
  if (!system) return "unknown";

  const forwarded =
    system.forwarder !== null &&
    system.forwarder.routes.some((route) => route.ip === alias.ip) &&
    !system.forwarder.failures.some((failure) => failure.route.ip === alias.ip);
  const resolves =
    system.managedHosts.includes(alias.hostname) &&
    system.loopbackIps.includes(alias.ip) &&
    forwarded;
  if (resolves) return "live";

  // Saved but not live. Why not, exactly, is the auto-apply state's business; with
  // auto-apply off or the tray down there is no queue and the banner is the way back.
  return auto.phase === "idle" ? "unapplied" : auto.phase;
}

/** True only when the name really resolves. The cable and the chip both hang off this. */
export function isLive(phase: AliasApply): boolean {
  return phase === "live" || phase === "unknown";
}

const CHIPS: Record<string, ApplyChip> = {
  saving: {
    label: "saving",
    title: "Writing this alias to the config.",
  },
  scheduled: {
    label: "applying",
    title:
      "Saved. The admin prompt is coming in a moment — this name does not resolve until you approve it.",
  },
  prompting: {
    // An instruction, not a noun: "password" alone reads like a field label.
    label: "approve",
    title:
      "Saved. Approve the admin prompt the menu-bar app raised and this name starts resolving.",
  },
  deferred: {
    label: "not live",
    title:
      "Saved, but you dismissed the admin prompt, so this name does not resolve yet. Nothing will ask again on its own.",
  },
  failed: {
    label: "not live",
    title: "Saved, but the last apply failed, so this name does not resolve yet.",
  },
  unapplied: {
    label: "not live",
    title:
      "Saved, but not applied to this Mac yet, so this name does not resolve. Re-apply from the banner or the status panel.",
  },
};

export function applyChip(phase: AliasApply): ApplyChip | null {
  return CHIPS[phase] ?? null;
}

/**
 * The reader every row uses. It subscribes to the one shared store rather than adding a
 * poll of its own, and hands back a plain function so a row stays a function of its props.
 */
export function useAliasApply(): (alias: AliasView) => AliasApply {
  const state: StatusState = useStatus();
  const auto = readAutoApply(state);
  return (alias) => aliasApply(alias, state.system, auto);
}
