"use client";

import { useStatus } from "../lib/client/status-store.ts";
import { readAutoApply, type AutoApplyPhase } from "./shell/auto-apply-read.ts";
import { useReapply } from "./shell/useReapply.ts";
import { LinkButton } from "./LinkButton.tsx";
import { Banner, type BannerTone } from "./ui/Banner.tsx";
import { Button } from "./ui/Button.tsx";
import { CodeBlock } from "./ui/CodeBlock.tsx";

export interface DriftCopy {
  testId: "banner-applying" | "banner-drift";
  tone: BannerTone;
  title: string;
  body: string;
  /** Null means no button: a prompt is already on its way and a second one is not help. */
  action: "Re-apply now" | "Try again" | null;
}

/**
 * What the banner says, as data — the four automatic-apply states plus the two the app
 * has always had. Pure, so the wording can be tested without a browser.
 */
export function driftCopy(phase: AutoApplyPhase, neverApplied: boolean): DriftCopy {
  switch (phase) {
    case "scheduled":
      return {
        testId: "banner-applying",
        tone: "info",
        title: "Applying in a moment",
        body: "Your change is saved. The menu-bar app raises one admin prompt for everything pending in a second — adding three aliases in a row still costs one password.",
        action: null,
      };
    case "prompting":
      return {
        testId: "banner-applying",
        tone: "info",
        title: "Waiting for your password",
        body: "The menu-bar app has raised the admin prompt. Approve it and these names start resolving; dismiss it and nothing on this Mac changes. Your aliases are saved either way.",
        action: null,
      };
    case "deferred":
      return {
        testId: "banner-drift",
        tone: "warn",
        title: "You dismissed the admin prompt",
        body: "Your aliases are saved and nothing on this Mac has changed. Nothing will ask again on its own — a password dialog that comes back because you dismissed it is malware behaviour — so this button is the way back.",
        action: "Try again",
      };
    case "failed":
      return {
        testId: "banner-drift",
        tone: "danger",
        title: "The last apply failed",
        body: "Your aliases are saved and nothing on this Mac has changed. The privileged step reported:",
        action: "Try again",
      };
    default:
      return neverApplied
        ? {
            testId: "banner-drift",
            tone: "warn",
            title: "Nothing is applied on this Mac yet",
            body: "Your aliases exist in the config, but no hostname resolves yet. Applying writes the managed /etc/hosts block, adds the loopback addresses and starts the forwarder.",
            action: "Re-apply now",
          }
        : {
            testId: "banner-drift",
            tone: "warn",
            title: "Live state has drifted",
            body: "What is live on this Mac no longer matches your aliases — a reboot clears loopback addresses, so this is expected after one. Until it is re-applied, these names will not resolve.",
            action: "Re-apply now",
          };
  }
}

/**
 * The honest banner. lo0 aliases do not survive a reboot, so live state drifts away
 * from the config on its own — and when it does, names stop resolving.
 *
 * One button re-applies. What it can finish on its own it finishes: the desired-state
 * and routes files are rewritten and the running forwarder picks up port changes with
 * no prompt at all. What needs root, it hands over verbatim rather than pretending —
 * the dashboard is an unprivileged process, and the menu-bar app raises the one prompt.
 *
 * With automatic apply on, that same drift is usually already being dealt with, so the
 * banner says which of the four things is happening instead of offering a button that
 * would ask for a second password dialog covering the same reconcile. With the setting
 * off — or with the menu-bar app down — this banner and its button are the whole path,
 * exactly as they were before automatic apply existed.
 */
export function DriftBanner() {
  const state = useStatus();
  const { loaded, reachable, error, sync, system } = state;
  const auto = readAutoApply(state);
  const reapply = useReapply();

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
  const copy = driftCopy(auto.phase, neverApplied);

  return (
    <div data-testid={copy.testId} data-phase={auto.phase}>
      <Banner
        tone={copy.tone}
        title={copy.title}
        actions={
          copy.action ? (
            <>
              <Button
                variant="primary"
                size="sm"
                busy={reapply.busy}
                onClick={reapply.run}
                data-testid="reapply"
              >
                {copy.action}
              </Button>
              <LinkButton href="/onboarding" variant="ghost" size="sm">
                Open setup
              </LinkButton>
            </>
          ) : null
        }
      >
        {copy.body}

        {auto.phase === "failed" && auto.error ? (
          <span className="mono mt-2 block text-[11px] text-danger" data-testid="apply-error">
            {auto.error}
          </span>
        ) : null}

        {drift.length > 0 ? (
          <ul className="mono mt-2 space-y-0.5 text-[11px] text-faint">
            {drift.map((reason) => (
              <li key={reason}>— {reason}</li>
            ))}
          </ul>
        ) : null}

        {reapply.intent && reapply.intent.command.length > 0 ? (
          <CodeBlock
            className="mt-3"
            label="the dashboard cannot run this — the menu-bar app does, behind one prompt"
            value={reapply.intent.command.join(" ")}
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
