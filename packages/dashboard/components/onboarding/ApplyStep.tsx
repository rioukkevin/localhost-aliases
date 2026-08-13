"use client";

import type { OnboardingStep } from "@localhost-aliases/core/types";
import { Button } from "../ui/Button.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { StepShell } from "./StepShell.tsx";
import { usePrivilegedApply } from "./usePrivilegedApply.ts";

export interface ApplyStepProps {
  index: number;
  step: OnboardingStep;
  /** The privileged command, verbatim, as the fallback the user can run themselves. */
  command: string;
  /** Reasons only root can resolve, from the live diff. */
  reasons: string[];
  needsPrompt: boolean;
  disabled?: boolean;
  /** Re-read the machine once the tray reports success. */
  onApplied: () => void | Promise<void>;
}

type Tone = "muted" | "down" | "danger" | "live";

const TONE_CLASS: Record<Tone, string> = {
  muted: "text-muted",
  down: "text-down",
  danger: "text-danger",
  live: "text-live",
};

/**
 * The one privileged moment, driven for real.
 *
 * The dashboard cannot raise a macOS admin prompt, so this button writes a request the
 * menu-bar app picks up, and then reports honestly what came back: the prompt is open,
 * you dismissed it, it failed with this exact error, or the menu-bar app is not running
 * at all — in which case the command below is the way out.
 */
export function ApplyStep({
  index,
  step,
  command,
  reasons,
  needsPrompt,
  disabled = false,
  onApplied,
}: ApplyStepProps) {
  const { progress, ready, asking, problem, ask } = usePrivilegedApply(onApplied);
  const result = progress.state === "done" ? progress.result : null;
  const waiting = asking || progress.state === "pending";
  // Only once the first read has come back: before that `trayAlive` is a placeholder false,
  // and announcing "the menu-bar app is not running" on every page load would be a lie.
  const trayDown = ready && progress.state === "idle" && !progress.trayAlive;
  const trayMissing = problem !== null || trayDown;

  const label = waiting
    ? "Waiting for your password…"
    : result && !result.ok
      ? "Try again"
      : step.state === "done"
        ? "Apply again"
        : "Prepare and apply";

  const notice: { tone: Tone; text: string } | null = problem
    ? { tone: "danger", text: problem }
    : waiting
      ? {
          tone: "down",
          text:
            "macOS is asking for your password in the menu-bar app — look for the Localhost Aliases " +
            "icon at the top of the screen. This page updates itself as soon as you answer it.",
        }
      : result?.cancelled
        ? { tone: "down", text: "You dismissed the password prompt, so nothing was changed. Nothing is half-applied." }
        : result && !result.ok
          ? { tone: "danger", text: result.error ?? "The privileged step failed without saying why." }
          : result?.ok
            ? { tone: "live", text: "Applied. /etc/hosts, the loopback addresses and the forwarder now match." }
            : trayDown
              ? {
                  tone: "down",
                  text:
                    "The Localhost Aliases menu-bar app does not look like it is running, and it is the only " +
                    "thing that can raise the admin prompt. Start it, or run the command below yourself.",
                }
              : needsPrompt
                ? {
                    tone: "muted",
                    text: `Waiting on the prompt: ${reasons.join(" ") || "root work is pending."}`,
                  }
                : null;

  return (
    <StepShell
      index={index}
      step={step}
      actions={
        <>
          <Button
            variant="primary"
            busy={waiting}
            disabled={disabled}
            onClick={ask}
            data-testid="apply-now"
          >
            {label}
          </Button>
          <span className="text-[11px] text-faint">
            macOS asks for your password once, in the menu-bar app. Nothing runs as root
            afterwards except the forwarder, and it exits by itself when the app quits.
          </span>
        </>
      }
    >
      <p>
        This is the only privileged moment. This page never runs a privileged command — it
        writes the desired state, asks the menu-bar app to run this one idempotent script
        behind the standard macOS admin prompt, and waits for the answer. Running it twice
        changes nothing.
      </p>
      <CodeBlock
        className="mt-2"
        value={command}
        what="command"
        label={trayMissing ? "run this yourself instead" : "what will run"}
      />
      {notice ? (
        <p
          role="status"
          data-testid="apply-notice"
          className={`mt-2 text-[12.5px] ${TONE_CLASS[notice.tone]}`}
        >
          {notice.text}
        </p>
      ) : null}
    </StepShell>
  );
}
