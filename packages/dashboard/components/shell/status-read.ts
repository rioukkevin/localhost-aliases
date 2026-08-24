/**
 * The three honest readings the shell shows, derived from the one polled snapshot.
 *
 * All of them start as "unknown" and stay there until the machine has actually answered:
 * a placeholder that says "the menu-bar app is not running" is a statement about
 * the user's Mac, and we do not make it before we know.
 *
 * The middle reading — the ROOT AGENT — is the one that decides how the whole app talks
 * about passwords. There is one admin prompt, at the moment the agent starts. While it
 * runs it watches desired-state.json and reconciles /etc/hosts, the lo0 addresses and its
 * own routes by itself, so adding, renaming and deleting aliases cost nothing. No screen
 * may say "this change needs your password" while the agent is up, because it does not.
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
        note: "The menu-bar app is running and answering. It is what raises the one admin prompt that starts the root agent, and it keeps the heartbeat the agent watches — quit it and the agent exits on its own.",
      }
    : {
        tone: "down",
        value: "not running",
        note: "Nothing has touched the heartbeat file recently, so the one admin prompt cannot be raised from here and a running agent would soon exit by itself. Start the menu-bar app, or run the command below yourself.",
      };
}

/**
 * Is the root agent running?
 *
 * The agent IS the forwarder — one root process, not two. It already ran as root, already
 * had a heartbeat and already exited on its own when the app stopped touching the liveness
 * file, so reconciliation was added to it rather than to a second privileged process. That
 * is why this reading comes from `system.forwarder`: a live status file whose pid still
 * answers signal 0 is exactly "the agent is up".
 */
export function readAgent(state: StatusState): Reading {
  if (!state.loaded || !state.system) {
    return {
      tone: "unknown",
      value: "checking…",
      note: "Looking for the root agent's status file for the first time.",
    };
  }
  if (!state.reachable) {
    return {
      tone: "unknown",
      value: "unknown",
      note: "The dashboard server is not answering, so its reading of the root agent is out of date. Nothing on your Mac has changed.",
    };
  }
  const forwarder = state.system.forwarder;
  if (!forwarder) {
    return {
      tone: "down",
      value: "not running",
      note: "The root agent is not running, so no alias resolves and nothing is being forwarded. Starting it asks for your password once. After that it watches your aliases and applies every change on its own — adding, renaming and deleting names never prompts again.",
    };
  }
  const count = forwarder.routes.length;
  return {
    tone: "live",
    value: "running",
    note: `The root agent is running as root (pid ${forwarder.pid}) and forwarding ${count} ${count === 1 ? "name" : "names"}. It applies alias changes by itself — you will not be asked for your password again. It exits on its own when the app stops touching the heartbeat file, so quitting leaves nothing running as root.`,
  };
}

/** True only when we have actually seen the agent's process answer. */
export function agentRunning(state: StatusState): boolean {
  return state.loaded && state.reachable && state.system?.forwarder != null;
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
  const running = state.system.forwarder != null;
  const neverApplied =
    state.system.loopbackIps.length === 0 && state.system.managedHosts.length === 0;
  if (neverApplied) {
    return {
      tone: "down",
      value: "not set up",
      note: running
        ? "Your aliases exist in the config, but nothing is live yet. The root agent is running and reconciles this by itself — no password needed."
        : "Your aliases exist in the config, but nothing is applied yet, so no hostname resolves. Starting the root agent writes the managed /etc/hosts block, adds the loopback addresses and begins forwarding. That is the one admin prompt.",
    };
  }
  const drift = state.sync?.drift ?? state.system.drift;
  return {
    tone: "down",
    value: `drift:${drift.length || 1}`,
    note: running
      ? "What is live no longer matches your aliases. The root agent is running and watches for exactly this, so it should close on its own within a second or two — no password needed."
      : "What is live no longer matches your aliases — a reboot clears loopback addresses, so this is expected after one. The root agent is not running to fix it, so these names will not resolve until it is started.",
  };
}

/**
 * What the one button in the status panel says, and the sentence beside it.
 *
 * Pure, and separated from the component for the same reason `driftCopy` is: this is the
 * app's clearest statement of the prompt model, so it has to be assertable without a
 * browser. A React server render always sees the store's EMPTY server snapshot, which
 * would make a rendered assertion prove nothing about the loaded case.
 */
export interface ActionCopy {
  label: "Start the agent" | "Re-apply now" | "Try again";
  aside: string;
  /** Accent fill: something is actually wrong, or the user has to act. */
  primary: boolean;
}

export function readAction(input: {
  agentUp: boolean;
  applied: boolean;
  /** A dismissed or failed run — the only two states with something to retry. */
  retryable: boolean;
  /** A prompt is scheduled or already up. */
  inFlight: boolean;
}): ActionCopy {
  const label = input.retryable ? "Try again" : input.agentUp ? "Re-apply now" : "Start the agent";
  const aside = input.inFlight
    ? "one prompt is already on its way"
    : input.agentUp
      ? "the agent is up — nothing here asks for a password"
      : input.applied
        ? "nothing has drifted"
        : "one admin prompt, once — then never again";
  return { label, aside, primary: !(input.applied && input.agentUp && !input.retryable) };
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
