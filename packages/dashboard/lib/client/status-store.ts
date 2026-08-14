"use client";

/**
 * The single source of truth for live state.
 *
 * One timer per document, not one per component: the nav strip, the drift banner and
 * the alias rows all read the same snapshot, so they can never disagree. The poll
 * stops while the tab is hidden and refreshes the moment it comes back. A failed read
 * keeps the last good data on screen and only flips `reachable` — the UI dims rather
 * than empties.
 */
import { useSyncExternalStore } from "react";
import type { AliasView, Config, SystemState } from "@localhost-aliases/core/types";
import { errorMessage, fetchStatus, type SyncReport } from "./api.ts";

export const POLL_MS = 5000;

export interface StatusState {
  /** False until the first response — drives the skeleton, not `reachable`. */
  loaded: boolean;
  reachable: boolean;
  error: string | null;
  config: Config | null;
  aliases: AliasView[];
  system: SystemState | null;
  /** The config-vs-machine diff, and the command that would close it. */
  sync: SyncReport | null;
  /**
   * Is the menu-bar app answering its heartbeat? `null` until the first
   * successful read — before that the UI must say "unknown", never "not
   * running": that would be a false statement about the user's machine.
   */
  trayAlive: boolean | null;
  /** A mutation is in flight; the patchbay header shows "applying…". */
  busy: boolean;
  updatedAt: number;
}

const EMPTY: StatusState = {
  loaded: false,
  reachable: true,
  error: null,
  config: null,
  aliases: [],
  system: null,
  sync: null,
  trayAlive: null,
  busy: false,
  updatedAt: 0,
};

let state: StatusState = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function set(patch: Partial<StatusState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** Single-flighted: concurrent callers share one request. */
export function refreshStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchStatus()
    .then((payload) => {
      set({
        loaded: true,
        reachable: true,
        error: null,
        config: payload.config,
        aliases: payload.aliases,
        system: payload.system,
        sync: payload.sync,
        trayAlive: payload.trayAlive,
        updatedAt: Date.now(),
      });
    })
    .catch((err: unknown) => {
      // The tray reading came from the server we just lost, so it is no longer
      // knowledge — it drops back to unknown while the aliases stay on screen.
      set({ loaded: true, reachable: false, error: errorMessage(err), trayAlive: null });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function startTimer(): void {
  if (timer !== null || typeof document === "undefined" || document.hidden) return;
  timer = setInterval(() => void refreshStatus(), POLL_MS);
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stopTimer();
    return;
  }
  void refreshStatus();
  startTimer();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refreshStatus();
    startTimer();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopTimer();
    }
  };
}

/** The current snapshot for code outside React (and for tests). */
export function snapshot(): StatusState {
  return state;
}

/** Drops every subscriber's data. Only tests need it. */
export function resetStatus(): void {
  state = EMPTY;
}

const getSnapshot = () => state;
// Identical object on the server for every render, so hydration cannot mismatch.
const getServerSnapshot = () => EMPTY;

export function useStatus(): StatusState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Optimistic mutation with rollback. The caller supplies the local edit and the
 * request; on failure the previous alias list is restored and the error is rethrown
 * so the view can toast it.
 */
export async function mutateAliases<T>(
  optimistic: (aliases: AliasView[]) => AliasView[],
  run: () => Promise<T>,
): Promise<T> {
  const previous = state.aliases;
  set({ aliases: optimistic(previous), busy: true });
  try {
    const result = await run();
    await refreshStatus();
    return result;
  } catch (err) {
    set({ aliases: previous });
    throw err;
  } finally {
    set({ busy: false });
  }
}

/** For mutations that change no alias (settings, apply, uninstall). */
export async function withRefresh<T>(run: () => Promise<T>): Promise<T> {
  set({ busy: true });
  try {
    return await run();
  } finally {
    set({ busy: false });
    await refreshStatus();
  }
}
