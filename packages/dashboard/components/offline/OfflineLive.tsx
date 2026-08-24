"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as api from "../../lib/client/api.ts";
import { useStatus } from "../../lib/client/status-store.ts";
import { agentRunning } from "../shell/status-read.ts";
import { PageBody, PageHeader } from "../ui/PageHeader.tsx";
import { OfflineDetail } from "./OfflineDetail.tsx";

/**
 * How often we re-check the dev server's port.
 *
 * Deliberately faster than the app's 5s status poll, and deliberately its own timer. The
 * whole value of this page is noticing the moment `bun dev` finishes booting while the
 * user is still looking at it; five seconds of staring at a stale "no server" is exactly
 * the experience the page exists to replace. It is one TCP connect to 127.0.0.1, and it
 * stops dead while the tab is hidden.
 */
export const OFFLINE_POLL_MS = 2_000;

/**
 * The fuller page the root agent's inline 503 links to.
 *
 * It does NOT redirect and it does NOT auto-navigate when the server comes up: the user
 * came here from their own URL, and yanking them somewhere the instant a port opens
 * would lose whatever they were reading. The reading flips, a button appears, they click.
 */
export function OfflineLive() {
  const requested = useSearchParams()?.get("host") ?? "";
  // The shell already polls; this reads that same snapshot rather than adding a timer.
  const shell = useStatus();
  const agentUp = shell.loaded ? agentRunning(shell) : null;
  const [view, setView] = useState<api.OfflineView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function read() {
      try {
        const next = await api.fetchOffline(requested);
        if (cancelled) return;
        setView(next);
        setError(null);
      } catch (err) {
        // Keep the last good reading on screen: the dashboard being unreachable says
        // nothing about the user's dev server.
        if (!cancelled) setError(api.errorMessage(err));
      }
    }

    function start() {
      if (timer !== null || document.hidden) return;
      timer = setInterval(() => void read(), OFFLINE_POLL_MS);
    }
    function stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }
    function onVisibility() {
      if (document.hidden) return stop();
      void read();
      start();
    }

    void read();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [requested]);

  const live = view?.listening === true;

  return (
    <PageBody>
      <PageHeader title={live ? "It is answering now" : "Nothing is listening"}>
        {live
          ? "Something came up on the port this alias forwards to while you were here. This page re-checks every couple of seconds; it does not move you anywhere on its own."
          : "The dev server on the other end of this patch is not accepting connections. Below is which port that is, the command that starts it, and what to check if the port is right but the server bound somewhere we cannot reach."}
      </PageHeader>
      <OfflineDetail view={view} error={error} requested={requested} agentUp={agentUp} />
    </PageBody>
  );
}
