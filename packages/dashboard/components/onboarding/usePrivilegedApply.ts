"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivilegedKind, PrivilegedProgress } from "@localhost-aliases/core/types";
import * as api from "../../lib/client/api.ts";

/** Matches APPLY_POLL_MS on the tray side: about a second, and only while pending. */
const POLL_MS = 1_000;

const IDLE: PrivilegedProgress = { state: "idle", trayAlive: false, request: null, result: null };

export interface PrivilegedApply {
  progress: PrivilegedProgress;
  /** False until the first read of the channel has come back — before that, `progress`
   * is a placeholder and must not be reported to the user as the state of the machine. */
  ready: boolean;
  /** Between the click and the server's answer — no request exists yet. */
  asking: boolean;
  /** The server refused (no menu-bar app) or the call failed. Cleared by the next try. */
  problem: string | null;
  ask(): void;
}

/**
 * Drives one privileged request from the browser: ask, then poll for the tray's answer
 * about once a second, and stop the moment it is done or the tab goes away. `onApplied`
 * fires once per successful request so the page can refresh the real machine state.
 */
export function usePrivilegedApply(
  onApplied: () => void | Promise<void>,
  kind: PrivilegedKind = "apply",
): PrivilegedApply {
  const [progress, setProgress] = useState<PrivilegedProgress>(IDLE);
  const [id, setId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const announced = useRef<string | null>(null);
  const applied = useRef(onApplied);
  applied.current = onApplied;

  useEffect(() => {
    const read = () => setVisible(document.visibilityState === "visible");
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);

  // A request may already be in flight from before this page was loaded — adopt it
  // rather than showing "idle" while the admin prompt sits on screen.
  useEffect(() => {
    let cancelled = false;
    void api
      .fetchPrivilegedProgress()
      .then((current) => {
        if (cancelled) return;
        setProgress(current);
        if (current.state === "pending" && current.request) setId(current.request.id);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ask = useCallback(() => {
    setAsking(true);
    setProblem(null);
    void api
      .requestPrivileged(kind)
      .then((answer) => {
        if (answer.request === null) {
          setId(null);
          setProgress({ state: "idle", trayAlive: answer.trayAlive, request: null, result: null });
          setProblem(answer.error ?? "The request was refused.");
          return;
        }
        setId(answer.request.id);
        setProgress({ state: "pending", trayAlive: true, request: answer.request, result: null });
      })
      .catch((err: unknown) => setProblem(api.errorMessage(err)))
      .finally(() => setAsking(false));
  }, [kind]);

  useEffect(() => {
    if (id === null || progress.state === "done" || !visible) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.fetchPrivilegedProgress(id);
        if (!stopped) setProgress(next);
      } catch {
        // A single failed poll is not news: the next tick tries again.
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, progress.state, visible]);

  // The machine only changed if the tray says so, so the refresh hangs off the result.
  useEffect(() => {
    const result = progress.result;
    if (progress.state !== "done" || !result?.ok || announced.current === result.id) return;
    announced.current = result.id;
    void applied.current();
  }, [progress]);

  return { progress, ready, asking, problem, ask };
}
