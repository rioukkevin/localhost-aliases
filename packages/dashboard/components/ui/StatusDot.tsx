import type { AliasStatus } from "@localhost-aliases/core";

const TONE: Record<AliasStatus, { dot: string; ring: string; text: string }> = {
  up: { dot: "bg-live", ring: "border-live/40", text: "listening" },
  down: { dot: "bg-down", ring: "border-down/40", text: "no server" },
  unknown: { dot: "bg-faint", ring: "border-hairline-strong", text: "unknown" },
};

export interface StatusDotProps {
  status: AliasStatus;
  /** Adds the textual state next to the dot. */
  withLabel?: boolean;
  className?: string;
}

/** A jack-lamp: a dot inside a hairline ring, pulsing only when the upstream is up. */
export function StatusDot({ status, withLabel = false, className = "" }: StatusDotProps) {
  const tone = TONE[status] ?? TONE.unknown;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} data-status={status}>
      <span
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border ${tone.ring}`}
      >
        <span
          className={`block h-1.5 w-1.5 rounded-full ${tone.dot} ${status === "up" ? "dot-live" : ""}`}
        />
      </span>
      <span className={withLabel ? "text-[11px] text-muted" : "sr-only"}>{tone.text}</span>
    </span>
  );
}
