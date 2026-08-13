"use client";

import { useState } from "react";
import * as api from "../lib/client/api.ts";
import { refreshStatus, useStatus } from "../lib/client/status-store.ts";
import { LinkButton } from "./LinkButton.tsx";
import { Banner } from "./ui/Banner.tsx";
import { Button } from "./ui/Button.tsx";
import { CodeBlock } from "./ui/CodeBlock.tsx";
import { useToast } from "./ui/Toast.tsx";

/**
 * The honest banner. lo0 aliases do not survive a reboot, so live state drifts away
 * from the config on its own — and when it does, names stop resolving.
 *
 * One button re-applies. What it can finish on its own it finishes: the desired-state
 * and routes files are rewritten and the running forwarder picks up port changes with
 * no prompt at all. What needs root, it hands over verbatim rather than pretending —
 * the dashboard is an unprivileged process, and the menu-bar app raises the one prompt.
 */
export function DriftBanner() {
  const { loaded, reachable, error, sync, system } = useStatus();
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<api.ApplyIntent | null>(null);
  const toast = useToast();

  async function reapply() {
    setBusy(true);
    try {
      const result = await api.prepareApply();
      await refreshStatus();
      if (result.needsPrompt) {
        setIntent(result.intent);
        toast.push({
          tone: "info",
          title: "This part needs one admin prompt",
          detail: "Use the menu-bar app, or run the command shown in the banner.",
        });
      } else {
        setIntent(null);
        toast.push({ tone: "success", title: "state re-applied" });
      }
    } catch (err) {
      toast.push({ tone: "error", title: "Could not re-apply", detail: api.errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (loaded && !reachable) {
    return (
      <div data-testid="banner-unreachable">
        <Banner tone="danger" title="Lost contact with the dashboard server">
          The page is showing the last state it read. Nothing on your Mac has changed — your dev
          servers, /etc/hosts and the loopback addresses are exactly as they were.
          {error ? <span className="mono block pt-1 text-[11px] text-faint">{error}</span> : null}
        </Banner>
      </div>
    );
  }

  const applied = sync?.applied ?? system?.applied ?? true;
  if (!loaded || applied) return null;

  const drift = sync?.drift ?? system?.drift ?? [];
  const neverApplied =
    (system?.loopbackIps.length ?? 0) === 0 && (system?.managedHosts.length ?? 0) === 0;

  return (
    <div data-testid="banner-drift">
      <Banner
        tone="warn"
        title={neverApplied ? "Nothing is applied on this Mac yet" : "Live state has drifted"}
        actions={
          <>
            <Button variant="primary" size="sm" busy={busy} onClick={() => void reapply()} data-testid="reapply">
              Re-apply now
            </Button>
            <LinkButton href="/onboarding" variant="ghost" size="sm">
              Open setup
            </LinkButton>
          </>
        }
      >
        {neverApplied
          ? "Your aliases exist in the config, but no hostname resolves yet. Applying writes the managed /etc/hosts block, adds the loopback addresses and starts the forwarder."
          : "What is live on this Mac no longer matches your aliases — a reboot clears loopback addresses, so this is expected after one. Until it is re-applied, these names will not resolve."}
        {drift.length > 0 ? (
          <ul className="mono mt-2 space-y-0.5 text-[11px] text-faint">
            {drift.map((reason) => (
              <li key={reason}>— {reason}</li>
            ))}
          </ul>
        ) : null}
        {intent && intent.command.length > 0 ? (
          <CodeBlock
            className="mt-3"
            label="the dashboard cannot run this — the menu-bar app does, behind one prompt"
            value={intent.command.join(" ")}
            what="command"
          />
        ) : null}
        <span className="block pt-2 text-[12px] text-faint">
          Port changes need no prompt at all: the forwarder watches its routes file. Only
          hostname and address changes do.
        </span>
      </Banner>
    </div>
  );
}
