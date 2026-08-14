import { AbsoluteFill, useCurrentFrame } from "remotion";
import { brand, tagline } from "../brand.ts";
import { Backdrop } from "./Backdrop.tsx";
import { MorphLine } from "./MorphLine.tsx";
import { RackPanel } from "./RackPanel.tsx";
import { FROM, segmentText } from "./script.ts";
import { POSTER_FRAME, heroState, type HeroState } from "./state.ts";

/**
 * The only prose in the frame, and the only thing set in sans: everything else is machine
 * literal. The row already spells out the addresses, so repeating them here would teach
 * nothing — this says what the machinery is *for*.
 */
function Caption({ opacity, y }: { opacity: number; y: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 816,
        textAlign: "center",
        fontFamily: brand.sans,
        fontSize: 36,
        color: brand.muted,
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      {tagline}
    </div>
  );
}

/**
 * The still has no timeline to spend on the swap, so it states it: the port, struck
 * through in the accent, above the name that replaced it. The accent means the same thing
 * here as it does in the video, where it is the hairline that sweeps the name into place.
 */
function Replaced() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 150,
        textAlign: "center",
        fontFamily: brand.mono,
        fontSize: 40,
        letterSpacing: "-0.02em",
        // `faint` is the TLD/punctuation tone. This line is the whole point of the still —
        // the thing that got replaced — so it takes `muted`, the secondary-text tone.
        color: brand.muted,
      }}
    >
      <span style={{ position: "relative", display: "inline-block", lineHeight: "40px" }}>
        {segmentText(FROM)}
        <span
          style={{
            position: "absolute",
            left: -8,
            right: -8,
            /**
             * The optical middle of the glyphs, in pixels, not a percentage of the line
             * box — a percentage put the bar on the baseline and it read as an underline
             * clipping the descenders rather than as a strike. With line-height pinned to
             * the 40px font size the half-leading is zero, so the baseline sits at the
             * font's 0.75em ascent (30px) and the caps start at 0.68em above it (2.8px):
             * the caps band centres at 16px. The line mixes caps-height digits with x-height
             * lowercase, so it sits at 18 — between the two middles.
             */
            top: 18,
            height: 3,
            backgroundColor: brand.accent,
          }}
        />
      </span>
    </div>
  );
}

function Scene({ state, replaced = false }: { state: HeroState; replaced?: boolean }) {
  return (
    <AbsoluteFill>
      <Backdrop />
      {replaced && <Replaced />}
      <MorphLine from={state.from} to={state.to} sweep={state.sweep} />
      <RackPanel state={state} />
      <Caption opacity={state.caption.opacity} y={state.caption.y} />
    </AbsoluteFill>
  );
}

/**
 * The hero. Every animated value comes from `heroState`, which is pure and unit tested —
 * these components only decide where things sit.
 */
export function Hero() {
  return <Scene state={heroState(useCurrentFrame())} />;
}

/** The prefers-reduced-motion stand-in: the settled frame, plus the swap the video acts out. */
export function HeroStill() {
  return <Scene state={heroState(POSTER_FRAME)} replaced />;
}
