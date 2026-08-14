import { describe, expect, test } from "bun:test";
import { DURATION_IN_FRAMES, FPS, POSTER_FRAME, REST_FRAME, heroState } from "./state.ts";

const frames = Array.from({ length: DURATION_IN_FRAMES }, (_, f) => f);
const maxOpacity = (chars: { opacity: number }[]) => Math.max(...chars.map((c) => c.opacity));

describe("hero timeline", () => {
  test("runs 8-12s, the budget for a landing-page loop", () => {
    const seconds = DURATION_IN_FRAMES / FPS;
    expect(seconds).toBeGreaterThanOrEqual(8);
    expect(seconds).toBeLessThanOrEqual(12);
  });

  test("the last frame is the first frame, so the loop has no seam", () => {
    expect(heroState(DURATION_IN_FRAMES - 1)).toEqual(heroState(0));
  });

  test("nothing moves between REST_FRAME and the end", () => {
    const rest = heroState(REST_FRAME);
    for (let f = REST_FRAME; f < DURATION_IN_FRAMES; f++) expect(heroState(f)).toEqual(rest);
  });

  test("the poster frame is the patched state, not the empty one", () => {
    const poster = heroState(POSTER_FRAME);
    expect(poster.cable.live).toBe(1);
    expect(poster.cable.progress).toBe(1);
    expect(poster.caption.opacity).toBe(1);
    expect(maxOpacity(poster.to)).toBe(1);
  });

  test("the two hostnames are never legible at the same time", () => {
    for (const f of frames) {
      const s = heroState(f);
      expect(Math.min(maxOpacity(s.from), maxOpacity(s.to))).toBe(0);
    }
  });
});

describe("patch cable honesty", () => {
  test("never reads live unless it is fully plugged in", () => {
    for (const f of frames) {
      const { cable } = heroState(f);
      if (cable.live > 0) expect(cable.progress).toBe(1);
    }
  });

  test("drifts only while the upstream answers", () => {
    for (const f of frames) {
      const { cable } = heroState(f);
      if (cable.live === 0) expect(cable.dashOffset).toBe(0);
    }
  });

  test("carries bytes only while live, and only along the cable", () => {
    for (const f of frames) {
      const s = heroState(f);
      for (const packet of s.packets) {
        if (s.cable.live === 0) expect(packet.opacity).toBe(0);
        expect(packet.x).toBeGreaterThanOrEqual(0);
        expect(packet.x).toBeLessThanOrEqual(1);
      }
    }
  });

  test("the lamp is steady unless the cable is live", () => {
    for (const f of frames) {
      const s = heroState(f);
      if (s.cable.live === 0) expect(s.pulse).toBe(1);
    }
  });
});

describe("animation values stay in range", () => {
  test("every opacity is a real 0..1", () => {
    for (const f of frames) {
      const s = heroState(f);
      const opacities = [
        ...s.from.map((c) => c.opacity),
        ...s.to.map((c) => c.opacity),
        s.sweep.opacity,
        s.panel.opacity,
        s.row.opacity,
        s.chip.opacity,
        s.caption.opacity,
        s.cable.live,
        s.cable.progress,
        s.cable.flash,
      ];
      for (const value of opacities) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
