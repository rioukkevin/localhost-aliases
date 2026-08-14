import { AbsoluteFill } from "remotion";
import { brand, tagline } from "../brand.ts";
import { WebMark } from "./WebMark.tsx";

/**
 * The dashboard's PatchCable, fixed-width instead of responsive. Percentage geometry with
 * no viewBox is kept from the original so the dashes and jack radii stay pixel-constant;
 * the `translate(-INSET)` wrapper is what pulls the right jack INSET px in from the edge.
 */
const INSET = 13;
const CABLE_H = 46;

function Cable() {
  const mid = CABLE_H / 2;
  return (
    <div style={{ flex: 1, display: "flex" }}>
      <svg width="100%" height={CABLE_H} style={{ display: "block" }}>
        <circle cx={INSET} cy={mid} r="10" fill="none" stroke={brand.live} strokeWidth="1.8" opacity="0.55" />
        <circle cx={INSET} cy={mid} r="3.6" fill={brand.live} />
        <g transform={`translate(${-INSET},0)`}>
          <line
            x1={INSET * 2}
            y1={mid}
            x2="100%"
            y2={mid}
            stroke={brand.live}
            strokeWidth="2.2"
            strokeDasharray="11 11"
            strokeLinecap="round"
          />
          <circle cx="100%" cy={mid} r="10" fill="none" stroke={brand.live} strokeWidth="1.8" opacity="0.55" />
          <circle cx="100%" cy={mid} r="3.6" fill={brand.live} />
        </g>
      </svg>
    </div>
  );
}

const CAPS = {
  fontSize: 15,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  color: brand.faint,
} as const;

/**
 * 1200x630. What has to survive being shrunk to a 300px chat thumbnail is the wordmark,
 * the headline and the shape of the figure — so the figure is the app's own empty state
 * (a name, a cable, a port) at display size rather than a screenshot nobody could read.
 */
export function OgCard() {
  return (
    <AbsoluteFill style={{ background: brand.canvas, fontFamily: brand.sans, overflow: "hidden" }}>
      <AbsoluteFill style={{ padding: 72, justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* The re-cut mark, not the hairline UI one: this lockup is 34px on a card whose
              whole job is surviving a shrink to a 300px chat thumbnail. */}
          <WebMark size={34} />
          <span
            style={{
              fontFamily: brand.mono,
              fontSize: 27,
              fontWeight: 500,
              letterSpacing: "-0.02em",
              color: brand.ink,
            }}
          >
            localhost<span style={{ color: brand.faint }}>-</span>aliases
          </span>
        </div>

        <h1
          style={{
            margin: 0,
            marginTop: 56,
            maxWidth: 940,
            fontSize: 76,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1.06,
            color: brand.ink,
          }}
        >
          {tagline}
        </h1>

        <div
          style={{
            marginTop: 52,
            display: "flex",
            alignItems: "stretch",
            border: `1px solid ${brand.hairline}`,
            background: brand.raised,
          }}
        >
          <div style={{ width: 3, background: brand.accent }} />
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 30,
              padding: "24px 32px",
              fontFamily: brand.mono,
              fontSize: 38,
              letterSpacing: "-0.02em",
              color: brand.ink,
            }}
          >
            <span>
              myapp<span style={{ color: brand.faint }}>.local</span>
            </span>
            <Cable />
            <span>
              <span style={{ color: brand.faint }}>:</span>3000
            </span>
          </div>
        </div>

        <div style={{ marginTop: 52, ...CAPS }}>
          macos menu bar &nbsp;·&nbsp; one admin prompt &nbsp;·&nbsp; nothing installed permanently
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
