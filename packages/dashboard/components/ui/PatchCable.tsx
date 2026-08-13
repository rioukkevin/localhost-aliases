import type { AliasStatus } from "@localhost-aliases/core";

export interface PatchCableProps {
  status: AliasStatus;
  /** Vertical footprint. Rows use "row"; the empty-state figure uses "figure". */
  size?: "row" | "figure";
  className?: string;
}

/**
 * The connector between a name and a port.
 *
 * It scales by using percentage geometry instead of a viewBox, so the dash
 * pattern, the jack radii and the stroke weight stay pixel-constant at every
 * container width — a viewBox with preserveAspectRatio="none" would smear them.
 *
 * The `<g transform="translate(-INSET)">` wrapper is the trick that makes the
 * right jack sit INSET px from the right edge: percentages inside a group still
 * resolve against the viewport, so the translate just shifts the resolved point.
 */
const INSET = 9;

export function PatchCable({ status, size = "row", className = "" }: PatchCableProps) {
  const live = status === "up";
  const height = size === "figure" ? 40 : 28;
  const mid = height / 2;

  // One colour drives cable + jacks so the whole connector reads as one object.
  const tone = live ? "text-live" : status === "down" ? "text-down" : "text-faint";
  const cableOpacity = live ? 1 : 0.45;

  return (
    <svg
      className={`block w-full ${tone} ${className}`}
      height={height}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      {/* left jack */}
      <circle
        cx={INSET}
        cy={mid}
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.55"
      />
      <circle cx={INSET} cy={mid} r="2" fill="currentColor" />

      <g transform={`translate(${-INSET},0)`}>
        <line
          x1={INSET * 2}
          y1={mid}
          x2="100%"
          y2={mid}
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray="6 6"
          strokeLinecap="round"
          opacity={cableOpacity}
          className={live ? "cable-live" : ""}
        />
        {/* right jack */}
        <circle
          cx="100%"
          cy={mid}
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.55"
        />
        <circle cx="100%" cy={mid} r="2" fill="currentColor" />
      </g>
    </svg>
  );
}
