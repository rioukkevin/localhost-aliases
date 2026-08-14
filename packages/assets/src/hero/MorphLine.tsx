import { brand } from "../brand.ts";
import { FROM, TO, type Segment, type Tone } from "./script.ts";
import type { CharState } from "./state.ts";

const TONE: Record<Tone, string> = { ink: brand.ink, muted: brand.muted, faint: brand.faint };

const glyphs = (segments: Segment[]) =>
  segments.flatMap((segment) => [...segment.text].map((ch) => ({ ch, tone: segment.tone })));

const FROM_GLYPHS = glyphs(FROM);
const TO_GLYPHS = glyphs(TO);

function Line({ chars, states }: { chars: { ch: string; tone: Tone }[]; states: CharState[] }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: brand.mono,
        fontSize: 108,
        fontWeight: 500,
        letterSpacing: "-0.02em",
        whiteSpace: "pre",
      }}
    >
      {chars.map((glyph, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            color: TONE[glyph.tone],
            opacity: states[i]?.opacity ?? 0,
            transform: `translateY(${states[i]?.y ?? 0}px)`,
          }}
        >
          {glyph.ch}
        </span>
      ))}
    </div>
  );
}

/**
 * The claim, made in one place: a port you cannot read is swapped, glyph by glyph, for a
 * name you can. Both lines live in the same box so nothing shifts sideways as they trade.
 */
export function MorphLine({
  from,
  to,
  sweep,
}: {
  from: CharState[];
  to: CharState[];
  sweep: { x: number; width: number; opacity: number };
}) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 214, height: 190 }}>
      <Line chars={FROM_GLYPHS} states={from} />
      <Line chars={TO_GLYPHS} states={to} />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 160,
          height: 3,
          width: sweep.width,
          marginLeft: sweep.x - sweep.width / 2,
          backgroundColor: brand.accent,
          opacity: sweep.opacity,
        }}
      />
    </div>
  );
}
