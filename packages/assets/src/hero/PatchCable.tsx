import { interpolate, interpolateColors } from "remotion";
import { brand } from "../brand.ts";
import type { HeroState } from "./state.ts";

const JACK_INSET = 16;
const RING_R = 15;
const PIN_R = 5.5;
const HEIGHT = 64;

/**
 * The product's signature, scaled up from the dashboard's `PatchCable`: a dashed line
 * between two jacks that drifts *only* while the upstream answers. Here it also has to
 * plug itself in, so the line grows to the right jack before the jack lands.
 */
export function PatchCable({ length, cable, packets }: {
  length: number;
  cable: HeroState["cable"];
  packets: HeroState["packets"];
}) {
  const mid = HEIGHT / 2;
  const span = length - JACK_INSET * 2;
  const tone = interpolateColors(cable.live, [0, 1], [brand.faint, brand.live]);
  const tip = JACK_INSET + span * cable.progress;
  // The jack seats only once the cable has all but arrived.
  const seated = interpolate(cable.progress, [0.86, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <svg width={length} height={HEIGHT} style={{ display: "block", overflow: "visible" }}>
      <circle cx={JACK_INSET} cy={mid} r={RING_R} fill="none" stroke={tone} strokeWidth={2} opacity={0.55} />
      <circle cx={JACK_INSET} cy={mid} r={PIN_R} fill={tone} />

      <line
        x1={JACK_INSET + RING_R + 6}
        y1={mid}
        x2={Math.max(JACK_INSET + RING_R + 6, tip)}
        y2={mid}
        stroke={tone}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray="14 14"
        strokeDashoffset={cable.dashOffset}
        opacity={0.45 + 0.55 * cable.live}
      />

      {packets.map((packet, i) => (
        <circle
          key={i}
          cx={JACK_INSET + span * packet.x}
          cy={mid}
          r={5}
          fill={brand.live}
          opacity={packet.opacity}
        />
      ))}

      <g opacity={seated}>
        <circle cx={JACK_INSET + span} cy={mid} r={RING_R} fill="none" stroke={tone} strokeWidth={2} opacity={0.55} />
        <circle cx={JACK_INSET + span} cy={mid} r={PIN_R} fill={tone} />
      </g>

      {cable.flash > 0 && (
        <circle
          cx={JACK_INSET + span}
          cy={mid}
          r={cable.flashRadius}
          fill="none"
          stroke={brand.live}
          strokeWidth={2}
          opacity={cable.flash * 0.9}
        />
      )}
    </svg>
  );
}
