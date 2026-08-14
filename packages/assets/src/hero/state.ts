import { Easing, interpolate, spring } from "remotion";
import { FROM_LENGTH, TO_LENGTH } from "./script.ts";

export const FPS = 30;
/** 11s. Long enough to read the transformation twice, short enough to sit on a landing page. */
export const DURATION_IN_FRAMES = 348;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/**
 * The frame the poster and the reduced-motion still are taken from: alias patched, cable
 * live, caption settled. Frame 0 is the "before" state — a poster of it would advertise
 * the problem instead of the product.
 */
export const POSTER_FRAME = 238;

/**
 * Every window closes before REST_FRAME, so frames REST_FRAME..DURATION-1 are one static
 * still — and that still is identical to frame 0. That is what makes the loop seamless.
 */
export const REST_FRAME = 340;

const ENTER_Y = 26;
const EXIT_Y = 30;
/** Dash period is 28px; 1.4px/frame is two periods per 1.4s, the dashboard's cable speed. */
const DASH_SPEED = 1.4;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type Window = readonly [number, number];

/**
 * A spring that is *exactly* 0 before the window and *exactly* 1 after it. The hard
 * endpoints are what make the loop provable rather than hopeful: `spring` only approaches
 * its target, so left alone it would leave a sub-pixel drift on the last frame.
 */
function ease(frame: number, [from, to]: Window, damping = 200): number {
  if (frame <= from) return 0;
  if (frame >= to) return 1;
  return spring({ frame: frame - from, fps: FPS, durationInFrames: to - from, config: { damping } });
}

/**
 * Same hard endpoints, but on an easing curve rather than a spring — for motion that has
 * to *arrive*, like a plug travelling the last inch into its jack. A settling spring gets
 * there 90% of the way in the first half and then crawls, which reads as a stall.
 */
function curve(frame: number, [from, to]: Window, easing: (t: number) => number): number {
  if (frame <= from) return 0;
  if (frame >= to) return 1;
  return interpolate(frame, [from, to], [0, 1], { easing });
}

/** Per-character delay, optionally dealt from the right so exits peel the opposite way. */
function stagger(
  frame: number,
  count: number,
  index: number,
  start: number,
  step: number,
  duration: number,
  fromRight: boolean,
): number {
  const order = fromRight ? count - 1 - index : index;
  const begin = start + order * step;
  return ease(frame, [begin, begin + duration]);
}

export type CharState = { opacity: number; y: number };

/**
 * One glyph, from an entrance progress and an exit progress. Anything fully transparent is
 * normalised to y=0 so two invisible states compare equal — the loop test depends on it.
 */
function charState(enter: number, exit: number): CharState {
  const opacity = clamp01(enter - exit);
  if (opacity === 0) return { opacity: 0, y: 0 };
  return { opacity, y: exit > 0 ? -exit * EXIT_Y : (1 - enter) * ENTER_Y };
}

function block(frame: number, inWindow: Window, outWindow: Window, rise: number, fall: number) {
  const enter = ease(frame, inWindow);
  const exit = ease(frame, outWindow);
  const opacity = clamp01(enter - exit);
  if (opacity === 0) return { opacity: 0, y: 0 };
  return { opacity, y: exit > 0 ? exit * fall : (1 - enter) * rise };
}

/** Frame marks. Everything the hero does hangs off this one table. */
const M = {
  fromExit: 42,
  fromReturn: 316,
  toEnter: 70,
  toExit: 288,
  sweep: [44, 96] as Window,
  panelIn: [92, 130] as Window,
  panelOut: [292, 312] as Window,
  rowIn: [116, 154] as Window,
  rowOut: [286, 306] as Window,
  cableIn: [148, 192] as Window,
  cableOut: [278, 302] as Window,
  connect: 192,
  liveIn: [192, 206] as Window,
  liveOut: [266, 278] as Window,
  chipIn: [198, 224] as Window,
  chipOut: [264, 280] as Window,
  captionIn: [206, 232] as Window,
  captionOut: [266, 284] as Window,
} as const;

export type HeroState = {
  from: CharState[];
  to: CharState[];
  /** The one accent gesture: a hairline that sweeps the name into place. */
  sweep: { x: number; width: number; opacity: number };
  panel: { opacity: number; y: number };
  row: { opacity: number; y: number };
  cable: { progress: number; live: number; dashOffset: number; flash: number; flashRadius: number };
  /** Bytes on the wire. `x` is a fraction of the cable's length. */
  packets: { x: number; opacity: number }[];
  chip: { opacity: number; y: number };
  caption: { opacity: number; y: number };
  /** Lamp brightness: 1 at rest, breathing only while the upstream answers. */
  pulse: number;
};

export function heroState(frame: number): HeroState {
  const from: CharState[] = [];
  for (let i = 0; i < FROM_LENGTH; i++) {
    const exit = stagger(frame, FROM_LENGTH, i, M.fromExit, 1.3, 11, true);
    const back = stagger(frame, FROM_LENGTH, i, M.fromReturn, 0.9, 11, false);
    // Once the line starts coming back, how it left stops mattering.
    from.push(back > 0 ? charState(back, 0) : charState(1, exit));
  }

  const to: CharState[] = [];
  for (let i = 0; i < TO_LENGTH; i++) {
    const enter = stagger(frame, TO_LENGTH, i, M.toEnter, 2, 18, false);
    const exit = stagger(frame, TO_LENGTH, i, M.toExit, 1.5, 11, true);
    to.push(charState(enter, exit));
  }

  const sweepP = interpolate(frame, M.sweep, [0, 1], {
    easing: Easing.inOut(Easing.sin),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sweepOn = frame > M.sweep[0] && frame < M.sweep[1];
  const sweepFade = sweepOn ? Math.sin(Math.PI * sweepP) ** 0.7 : 0;

  const grow = curve(frame, M.cableIn, Easing.inOut(Easing.quad));
  const retract = curve(frame, M.cableOut, Easing.in(Easing.quad));
  const live = clamp01(ease(frame, M.liveIn) - ease(frame, M.liveOut));

  const flashP = interpolate(frame, [M.connect, M.connect + 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const flash = frame > M.connect && frame < M.connect + 26 ? (1 - flashP) ** 1.4 : 0;

  const packets = [0, 1].map((slot) => {
    const t = (((frame - M.connect - slot * 22) % 44) + 44) % 44 / 44;
    const opacity = live > 0 ? Math.sin(Math.PI * t) ** 0.8 * live : 0;
    return opacity > 0 ? { x: t, opacity } : { x: 0, opacity: 0 };
  });

  return {
    from,
    to,
    sweep: sweepFade > 0
      ? { x: interpolate(sweepP, [0, 1], [-560, 560]), width: 300 * Math.sin(Math.PI * sweepP), opacity: sweepFade }
      : { x: 0, width: 0, opacity: 0 },
    panel: block(frame, M.panelIn, M.panelOut, 26, 14),
    row: block(frame, M.rowIn, M.rowOut, 18, 10),
    cable: {
      progress: grow * (1 - retract),
      live,
      dashOffset: live > 0 ? -((frame - M.connect) * DASH_SPEED) : 0,
      flash,
      flashRadius: flash > 0 ? 16 + 46 * Easing.out(Easing.quad)(flashP) : 0,
    },
    packets,
    chip: block(frame, M.chipIn, M.chipOut, 10, 6),
    caption: block(frame, M.captionIn, M.captionOut, 14, 8),
    pulse: 1 - 0.5 * live * (0.5 - 0.5 * Math.cos(((frame - M.connect) * Math.PI * 2) / 72)),
  };
}
