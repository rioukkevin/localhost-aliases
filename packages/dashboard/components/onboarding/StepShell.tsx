"use client";

import type { OnboardingStep } from "@localhost-aliases/core/types";
import type { ReactNode } from "react";
import { Chip } from "../ui/Chip.tsx";
import type { ChipTone } from "../ui/Chip.tsx";
import { Spinner } from "../ui/Button.tsx";

const STATE_TONE: Record<OnboardingStep["state"], ChipTone> = {
  pending: "muted",
  running: "accent",
  done: "live",
  failed: "down",
  skipped: "muted",
};

export interface StepShellProps {
  index: number;
  step: OnboardingStep;
  optional?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}

/** One step of the flow: its real state, what it does, and the button that does it. */
export function StepShell({ index, step, optional = false, children, actions }: StepShellProps) {
  const done = step.state === "done";
  return (
    <li
      className="flex gap-4 border-t border-hairline px-4 py-5 first:border-t-0 md:px-6"
      data-testid={`step-${step.id}`}
      data-state={step.state}
    >
      <span
        aria-hidden="true"
        className={[
          "mono mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px]",
          done ? "border-live/40 text-live" : "border-hairline-strong text-faint",
        ].join(" ")}
      >
        {done ? "✓" : index}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight text-ink">{step.title}</h3>
          <Chip tone={STATE_TONE[step.state]} dot={step.state !== "pending"}>
            {step.state}
          </Chip>
          {optional ? <Chip tone="muted">optional</Chip> : null}
          {step.state === "running" ? (
            <span role="status" className="flex items-center gap-1.5 text-[11px] text-accent">
              <Spinner />
              working…
            </span>
          ) : null}
        </div>

        <div className="mt-2 text-[12.5px] leading-relaxed text-muted">{children}</div>

        {step.detail ? (
          <p
            className={`mono mt-2 break-words text-[11px] ${
              step.state === "failed" ? "text-danger" : "text-faint"
            }`}
          >
            {step.detail}
          </p>
        ) : null}

        {actions ? <div className="mt-3.5 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </li>
  );
}
