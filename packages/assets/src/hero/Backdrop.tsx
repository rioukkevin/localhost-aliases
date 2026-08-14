import { AbsoluteFill } from "remotion";
import { brand } from "../brand.ts";
import { Mark } from "../Mark.tsx";

/** 8% white is the dashboard's hairline; a full grid at that strength would shout, so the
 *  instrument grid runs at a quarter of it and the panel keeps the real hairline. */
const GRID = "rgba(255,255,255,0.02)";
const GRID_STEP = 96;

/**
 * Everything that never moves: the ground, the instrument grid, the mark and the two
 * standing notes. Holding it perfectly still is deliberate — the loop seam lands here.
 */
export function Backdrop() {
  return (
    <AbsoluteFill style={{ backgroundColor: brand.canvas }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${GRID} 1px, transparent 1px), linear-gradient(90deg, ${GRID} 1px, transparent 1px)`,
          backgroundSize: `${GRID_STEP}px ${GRID_STEP}px`,
        }}
      />

      <div style={{ position: "absolute", left: 76, top: 68, display: "flex", alignItems: "center", gap: 14 }}>
        <Mark size={38} />
        <span
          style={{
            fontFamily: brand.mono,
            fontSize: 26,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: brand.ink,
          }}
        >
          localhost<span style={{ color: brand.faint }}>-</span>aliases
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          left: 78,
          bottom: 74,
          fontFamily: brand.mono,
          fontSize: 19,
          lineHeight: 1.7,
          letterSpacing: "-0.02em",
          color: brand.faint,
        }}
      >
        127.0.0.1
        <br />
        names → ports
      </div>
    </AbsoluteFill>
  );
}
