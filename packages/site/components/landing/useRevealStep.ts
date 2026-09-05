"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Which step of a figure the reader has scrolled to.
 *
 * The figure is a normal element in the flow — no sticky pane, no scroll track
 * padded out to three screens — so the whole effect is one number: how far the
 * element has travelled across the viewport, mapped onto `steps` beats.
 *
 * `0` is returned until the effect first runs, which is also what the server
 * renders, so the figure hydrates without a jump. Everything the figure says is
 * in the markup at step 0; the scroll only moves the emphasis.
 */

/**
 * The window of the crossing that the steps are spread over. Below START the
 * figure has only just appeared; above END it is on its way out. Stepping inside
 * that band means the chain fills while the figure is comfortably in view rather
 * than at the very edges of the screen.
 */
const START = 0.2;
const END = 0.72;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function useRevealStep(element: RefObject<HTMLElement | null>, steps: number): number {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const node = element.current;
    if (node === null || steps < 1) return;

    let frame = 0;

    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const viewport = window.innerHeight;
      // 0 when the top edge is at the bottom of the screen, 1 when the bottom
      // edge has passed the top of it. Always a positive denominator.
      const crossing = (viewport - rect.top) / (viewport + rect.height);
      const progress = clamp01((crossing - START) / (END - START));
      setStep(Math.min(steps - 1, Math.floor(progress * steps)));
    };

    // Scroll fires far more often than the screen repaints; one frame is enough.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [element, steps]);

  return step;
}
