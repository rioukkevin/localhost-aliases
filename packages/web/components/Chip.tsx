import type { ReactNode } from "react";

export type ChipTone = "live" | "down" | "accent" | "muted";

const TONE: Record<ChipTone, { text: string; border: string; dot: string }> = {
  live: { text: "text-live", border: "border-live/40", dot: "bg-live" },
  down: { text: "text-down", border: "border-down/40", dot: "bg-down" },
  accent: { text: "text-accent", border: "border-accent/40", dot: "bg-accent" },
  muted: { text: "text-muted", border: "border-hairline-strong", dot: "bg-faint" },
};

export interface ChipProps {
  tone?: ChipTone;
  /** Prefixes a small state lamp, matching the status dots elsewhere. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/** A state label. Deliberately square and hairline — not a pill badge. */
export function Chip({ tone = "muted", dot = false, children, className = "", ...rest }: ChipProps) {
  const t = TONE[tone];
  return (
    <span
      data-testid={rest["data-testid"]}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-2 py-[3px] text-[10px] uppercase tracking-[0.14em] ${t.text} ${t.border} ${className}`}
    >
      {dot ? <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${t.dot}`} /> : null}
      {children}
    </span>
  );
}
