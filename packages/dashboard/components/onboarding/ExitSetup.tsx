"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/Button.tsx";
import type { ExitPlan } from "./exit-state.ts";

/** URLs are machine-literal, so they are set in mono wherever they land in prose. */
function withMonoUrls(line: string): ReactNode[] {
  return line.split(/(\bhttps?:\/\/\S+)/).map((part, i) =>
    part.startsWith("http") ? (
      <span key={i} className="mono text-ink">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export interface ExitSetupProps {
  plan: ExitPlan;
  /** Only its own request; nothing else in the flow may disable this control. */
  busy?: boolean;
  onExit: () => void;
  /** Quiet companions (start over). Never competes with the primary. */
  secondary?: ReactNode;
}

/**
 * The end of the flow: one way out, always available, that tells the truth about the
 * state it is leaving. No dialog — the lines above the button carry the warning, in the
 * same dash-list rhythm the steps themselves use.
 */
export function ExitSetup({ plan, busy = false, onExit, secondary }: ExitSetupProps) {
  return (
    <div data-testid="onboarding-exit-note">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
        leaving setup
      </p>

      <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-ink">{plan.headline}</p>

      {plan.missing.length > 0 ? (
        <ul className="mt-2 max-w-2xl space-y-1 text-[12.5px] leading-relaxed text-muted">
          {plan.missing.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden="true" className="text-faint">
                —
              </span>
              <span>{withMonoUrls(line)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-muted">{plan.note}</p>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          aria-label={plan.ariaLabel}
          busy={busy}
          onClick={onExit}
          data-testid="onboarding-exit"
          className="min-w-[14rem]"
        >
          {plan.label}
        </Button>
        {secondary}
      </div>
    </div>
  );
}
