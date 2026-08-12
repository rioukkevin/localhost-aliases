"use client";

/**
 * The single source of truth for `GET /api/status`.
 *
 * There used to be two independent polls — the status strip every 10s and the
 * aliases store every 5s. That doubled the cost of a route which probes the
 * helper socket, shells `security(1)` for the CA and stats two MCP client
 * configs, and it let the strip disagree with a just-saved setting for up to
 * ten seconds.
 *
 * Now there is exactly one timer per document, shared by every subscriber, and
 * every successful mutation invalidates it immediately through `status-bus.ts`,
 * so a settings change lands in the strip as soon as the server has answered.
 * The poll still stops while the tab is hidden.
 */
import { useSyncExternalStore } from "react";
import type { SystemStatus } from "@localhost-aliases/core";
import * as api from "./api.ts";
import { onServerStateChanged } from "./status-bus.ts";

const POLL_MS = 5000;

/** `/api/status` also returns copy-pasteable commands; not part of the frozen type. */
export type StatusWithCommands = SystemStatus & {
  commands?: { install?: string; start?: string; trust?: string };
};

export interface SystemStatusSnapshot {
  status: StatusWithCommands | null;
  /** False once a read has failed: the dashboard API itself is not answering. */
  reachable: boolean;
  /** True after the first completed read, successful or not. */
  loaded: boolean;
}

const EMPTY: SystemStatusSnapshot = { status: null, reachable: true, loaded: false };

let snapshot: SystemStatusSnapshot = EMPTY;
const subscribers = new Set<() => void>();
let timer: number | undefined;
let unbind: (() => void) | null = null;
let inFlight: Promise<void> | null = null;

function publish(next: SystemStatusSnapshot): void {
  snapshot = next;
  for (const notify of [...subscribers]) notify();
}

/**
 * Single-flighted: several components mounting in the same tick, or a burst of
 * mutations, still cost one request. A failed read keeps the last good status
 * on screen and only flips `reachable`, so the UI dims rather than empties.
 */
export function refreshSystemStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      publish({ status: await api.fetchStatus(), reachable: true, loaded: true });
    } catch {
      publish({ status: snapshot.status, reachable: false, loaded: true });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function start(): void {
  const restart = () => {
    window.clearInterval(timer);
    timer = window.setInterval(() => void refreshSystemStatus(), POLL_MS);
  };
  const onVisibility = () => {
    if (document.hidden) {
      window.clearInterval(timer);
      timer = undefined;
    } else {
      void refreshSystemStatus();
      restart();
    }
  };
  const offBus = onServerStateChanged(() => void refreshSystemStatus());

  void refreshSystemStatus();
  if (!document.hidden) restart();
  document.addEventListener("visibilitychange", onVisibility);

  unbind = () => {
    window.clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
    offBus();
  };
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      unbind?.();
      unbind = null;
    }
  };
}

export function useSystemStatus(): SystemStatusSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}
