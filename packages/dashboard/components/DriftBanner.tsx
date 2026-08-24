"use client";

import { useStatus } from "../lib/client/status-store.ts";
import { readAutoApply, type AutoApplyPhase } from "./shell/auto-apply-read.ts";
import { agentRunning } from "./shell/status-read.ts";
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
  /**
   * Null means no button: either a prompt is already on its way and a second one is not
   * help, or the root agent is up and closing the gap by itself.
   */
  action: "Re-apply now" | "Try again" | "Start the agent" | null;
}

/**
 * What the banner says, as data — the automatic-apply states plus the two the app has
 * always had, each in two versions: one for a Mac where the root agent is running and one
 * for a Mac where it is not. Pure, so the wording can be tested without a browser.
 *
 * That split IS the prompt model. With the agent up there is nothing to prompt for: it
 * watches the desired state and reconciles /etc/hosts, the lo0 addresses and its routes
 * itself, so drift closes on its own and the banner must not offer a password dialog that
 * would never appear. With the agent down, one prompt starts it — and that same prompt
 * covers every change already made and every change after.
 */
export function driftCopy(
  phase: AutoApplyPhase,
  neverApplied: boolean,
  agentUp = false,
): DriftCopy {
  switch (phase) {
    case "scheduled":
      return {
        testId: "banner-applying",
        tone: "info",
        title: agentUp ? "Applying in a moment" : "Starting the root agent in a moment",
        body: agentUp
          ? "Your change is saved. The root agent is already running, so this settles by itself in a second — nothing is going to ask for your password."
          : "Your change is saved. The menu-bar app raises the one admin prompt in a second, and the root agent it starts applies everything pending — and everything you change after it — without asking again.",
        action: null,
      };
    case "prompting":
      return {
        testId: "banner-applying",
        tone: "info",
        title: "Waiting for your password",
        body: "The menu-bar app has raised the one admin prompt: the one that starts the root agent. Approve it and these names start resolving, and alias changes stop asking. Dismiss it and nothing on this Mac changes. Your aliases are saved either way.",
        action: null,
      };
    case "deferred":
      return {
        testId: "banner-drift",
        tone: "warn",
        title: "You dismissed the admin prompt",
        body: "Your aliases are saved and nothing on this Mac has changed. Nothing will ask again on its own — a password dialog that comes back because you dismissed it is malware behaviour — so this button is the way back. It is still one prompt, and still the only one.",
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
      if (agentUp) {
        return {
          testId: "banner-applying",
          tone: "info",
          title: "The agent is catching up",
          body: "The root agent is running and watches your aliases, so it reconciles this by itself — usually before you finish reading this. Nothing here needs your password.",
          action: null,
        };
      }
      return neverApplied
        ? {
            testId: "banner-drift",
            tone: "warn",
            title: "Nothing is applied on this Mac yet",
            body: "Your aliases exist in the config, but no hostname resolves yet. Starting the root agent writes the managed /etc/hosts block, adds the loopback addresses and begins forwarding. That is the one admin prompt; every alias you add afterwards is free.",
            action: "Start the agent",
          }
        : {
            testId: "banner-drift",
            tone: "warn",
            title: "Live state has drifted",
            body: "What is live on this Mac no longer matches your aliases — a reboot clears loopback addresses, so this is expected after one. The root agent is not running to put it back, so these names will not resolve until it is started.",
            action: "Start the agent",
          };
  }
}

/**
 * The honest banner. lo0 aliases do not survive a reboot, so live state drifts away from
 * the config on its own — and when it does, names stop resolving.
 *
 * Which of two stories it tells depends entirely on one fact: is the root agent running?
 *
 *   Running — the agent watches the desired state and puts /etc/hosts, lo0 and its routes
 *   back by itself. The banner reports that and offers no button, because there is nothing
 *   for the user to approve and a button implying otherwise would be a lie.
 *
 *   Not running — nothing on this Mac is reconciling anything. One admin prompt starts the
 *   agent, and that prompt covers everything pending and everything after it. The button
 *   asks the menu-bar app to raise it; if the menu-bar app is down we hand over the exact
 *   command instead of spinning, because the dashboard is unprivileged and stays that way.
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
  const agentUp = agentRunning(state);
  const copy = driftCopy(auto.phase, neverApplied, agentUp);

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
          {agentUp
            ? "Nothing here asks for a password. The root agent runs as root already and applies every change it sees, so adding, renaming and deleting aliases is free."
            : "One admin prompt, once: it starts the root agent. After that the agent applies every change on its own, and nothing asks again until you quit the app."}
        </span>
      </Banner>
    </div>
  );
}
