/**
 * The two honest readings the shell shows, derived from the one polled snapshot.
 *
 * Both start as "unknown" and stay there until the machine has actually answered:
 * a placeholder that says "the menu-bar app is not running" is a statement about
 * the user's Mac, and we do not make it before we know.
 */
import type { StatusState } from "../../lib/client/status-store.ts";

export type Tone = "live" | "down" | "unknown";

export interface Reading {
  tone: Tone;
  /** One or two words, set in mono next to the lamp. */
  value: string;
  /** A full sentence for the detail panel. */
  note: string;
}

export function readTray(state: StatusState): Reading {
  if (!state.loaded) {
    return {
      tone: "unknown",
      value: "checking…",
      note: "Reading the menu-bar app's heartbeat for the first time.",
    };
  }
  if (!state.reachable) {
    return {
      tone: "unknown",
      value: "unknown",
      note: "The dashboard server is not answering, so its reading of the menu-bar app is out of date. Nothing on your Mac has changed.",
    };
  }
  if (state.trayAlive === null) {
    return {
      tone: "unknown",
      value: "unknown",
      note: "This dashboard server did not report the heartbeat, so the menu-bar app's state is unknown.",
    };
  }
  return state.trayAlive
    ? {
        tone: "live",
        value: "live",
        note: "The menu-bar app is running and answering. It is what raises the one admin prompt when a change needs root.",
      }
    : {
        tone: "down",
        value: "not running",
        note: "Nothing has touched the heartbeat file recently, so no admin prompt can be raised from here. Start the menu-bar app, or run the command below yourself.",
      };
}

export function readInstall(state: StatusState): Reading {
  if (!state.loaded || !state.system) {
    return { tone: "unknown", value: "checking…", note: "Reading the live state of this Mac." };
  }
  const applied = state.sync?.applied ?? state.system.applied;
  if (applied) {
    return {
      tone: "live",
      value: "applied",
      note: "What is live on this Mac matches your aliases: the managed /etc/hosts block, the loopback addresses and the forwarder are all in place.",
    };
  }
  const neverApplied =
    state.system.loopbackIps.length === 0 && state.system.managedHosts.length === 0;
  if (neverApplied) {
    return {
      tone: "down",
      value: "not set up",
      note: "Your aliases exist in the config, but nothing is applied yet, so no hostname resolves. Re-applying writes the managed /etc/hosts block, adds the loopback addresses and starts the forwarder.",
    };
  }
  const drift = state.sync?.drift ?? state.system.drift;
  return {
    tone: "down",
    value: `drift:${drift.length || 1}`,
    note: "What is live no longer matches your aliases — a reboot clears loopback addresses, so this is expected after one. Until it is re-applied, these names will not resolve.",
  };
}

export const LAMP: Record<Tone, string> = {
  live: "bg-live dot-live",
  down: "bg-down",
  unknown: "bg-faint",
};

export const CHIP_TONE: Record<Tone, "live" | "down" | "muted"> = {
  live: "live",
  down: "down",
  unknown: "muted",
};
