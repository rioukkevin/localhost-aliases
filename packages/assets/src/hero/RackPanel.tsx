import { interpolateColors } from "remotion";
import { brand } from "../brand.ts";
import { PatchCable } from "./PatchCable.tsx";
import { ALIAS } from "./script.ts";
import type { HeroState } from "./state.ts";

const PANEL = { left: 300, top: 470, width: 1320, header: 66, body: 224 } as const;
const CABLE = { left: 560, length: 480 } as const;
/** Row items are positioned inside the panel *body*, so the midline is body-relative. */
const MID = PANEL.body / 2;

const CAPS = {
  fontFamily: brand.sans,
  fontSize: 17,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.18em",
  color: brand.faint,
} as const;

function StatusDot({ live, pulse }: { live: number; pulse: number }) {
  const tone = interpolateColors(live, [0, 1], [brand.faint, brand.live]);
  return (
    <div
      style={{
        position: "absolute",
        left: 34,
        top: MID - 17,
        width: 34,
        height: 34,
        borderRadius: "50%",
        border: `2px solid ${tone}`,
        opacity: 0.45 + 0.55 * live,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ width: 14, height: 14, borderRadius: "50%", backgroundColor: tone, opacity: pulse }} />
    </div>
  );
}

function Chip({ opacity, y }: { opacity: number; y: number }) {
  return (
    <div
      style={{
        ...CAPS,
        position: "absolute",
        right: 26,
        top: 18,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 14px",
        border: `2px solid ${brand.live}`,
        borderRadius: 2,
        color: brand.live,
        fontSize: 16,
        letterSpacing: "0.14em",
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: brand.live }} />
      listening
    </div>
  );
}

/**
 * The mechanism, told without spin: a name, the loopback address it resolves to, a cable
 * carrying :80, and the port your dev server was already listening on. Nothing here claims
 * anything the forwarder does not actually do.
 */
export function RackPanel({ state }: { state: HeroState }) {
  const { panel, row, cable, packets, chip } = state;

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL.left,
        top: PANEL.top,
        width: PANEL.width,
        border: `2px solid ${brand.hairline}`,
        backgroundColor: brand.canvas,
        opacity: panel.opacity,
        transform: `translateY(${panel.y}px)`,
      }}
    >
      <div
        style={{
          position: "relative",
          height: PANEL.header,
          borderBottom: `2px solid ${brand.hairline}`,
          backgroundColor: brand.raised,
          display: "flex",
          alignItems: "center",
          gap: 20,
          paddingLeft: 32,
        }}
      >
        <span style={CAPS}>patchbay</span>
        <span style={{ fontFamily: brand.mono, fontSize: 18, color: brand.muted, letterSpacing: "-0.02em" }}>
          1 alias
        </span>
        <Chip opacity={chip.opacity} y={chip.y} />
      </div>

      <div style={{ position: "relative", height: PANEL.body, opacity: row.opacity }}>
        <div style={{ transform: `translateY(${row.y}px)` }}>
          <StatusDot live={cable.live} pulse={state.pulse} />

          <div style={{ position: "absolute", left: 92, top: MID - 46, fontFamily: brand.mono, letterSpacing: "-0.02em" }}>
            <div style={{ fontSize: 48, fontWeight: 500, lineHeight: 1.1, color: brand.ink }}>
              {ALIAS.host}
              <span style={{ color: brand.faint }}>{ALIAS.tld}</span>
            </div>
            <div style={{ fontSize: 22, marginTop: 12, color: brand.faint }}>{ALIAS.ip}</div>
          </div>

          <div style={{ position: "absolute", left: CABLE.left, top: MID - 32 }}>
            <PatchCable length={CABLE.length} cable={cable} packets={packets} />
          </div>
          <div
            style={{
              position: "absolute",
              left: CABLE.left,
              width: CABLE.length,
              top: MID - 74,
              textAlign: "center",
              fontFamily: brand.mono,
              fontSize: 20,
              letterSpacing: "-0.02em",
              color: brand.faint,
            }}
          >
            {ALIAS.wire}
          </div>

          <div
            style={{
              position: "absolute",
              right: 40,
              top: MID - 46,
              textAlign: "right",
              fontFamily: brand.mono,
              letterSpacing: "-0.02em",
            }}
          >
            <div style={{ fontSize: 48, fontWeight: 500, lineHeight: 1.1, color: brand.ink }}>
              <span style={{ color: brand.faint }}>:</span>
              {ALIAS.port}
            </div>
            <div style={{ fontSize: 22, marginTop: 12, color: brand.faint }}>{ALIAS.target}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
