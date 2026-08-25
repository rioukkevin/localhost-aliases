/**
 * Motion for the explanatory figures, shipped with the figures rather than in
 * globals.css so the graphics stay one self-contained unit.
 *
 * The rule every keyframe below obeys: **the markup already paints the still
 * picture, and an animation only deviates from it.** Nothing is positioned,
 * revealed or coloured by JavaScript, so the figures are complete on the server;
 * with scripting off, with animations killed, or on the very first painted frame,
 * a reader sees the same legible diagram. That is also why the reduced-motion
 * block can simply say `animation: none` — there is nothing to fall back to,
 * because the resting state *is* the fallback.
 */
const CSS = `
/* A browser tab being clicked, then let go of. Five tabs share one 7s cycle with
   staggered delays, so exactly one is "open" at a time and the scan reads as
   hunting rather than as a light show. Resting state: none of them highlighted,
   which is the point the figure is making. */
@keyframes la-probe {
  0%, 3% {
    border-color: var(--hairline);
    background: var(--sunken);
    color: var(--muted);
  }
  7%, 15% {
    border-color: var(--hairline-strong);
    background: var(--raised);
    color: var(--ink);
  }
  19%, 100% {
    border-color: var(--hairline);
    background: var(--sunken);
    color: var(--muted);
  }
}

.la-probe {
  animation: la-probe 7s ease-in-out infinite;
}

/* Bytes on a cable. It leaves the left jack, arrives at the right one and fades,
   9px in at each end so it starts and stops exactly at the jacks PatchCable
   draws. Invisible at rest (opacity 0), so a frozen frame is just the cable. */
@keyframes la-packet {
  0% {
    left: 9px;
    opacity: 0;
  }
  6% {
    opacity: 1;
  }
  30% {
    left: calc(100% - 9px);
    opacity: 1;
  }
  38%, 100% {
    left: calc(100% - 9px);
    opacity: 0;
  }
}

.la-packet {
  position: absolute;
  top: 50%;
  left: 9px;
  width: 5px;
  height: 5px;
  margin-top: -2.5px;
  margin-left: -2.5px;
  border-radius: 9999px;
  background: var(--live);
  opacity: 0;
  animation: la-packet 5.2s linear infinite;
}

/* One-shot entrances for the lines a privileged apply writes. They run once on
   load and never again — nothing loops next to prose here. */
@keyframes la-reveal {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
}

.la-reveal {
  animation: la-reveal 420ms ease-out both;
}

@keyframes la-bar {
  from {
    transform: scaleY(0);
  }
}

.la-bar {
  transform-origin: top;
  animation: la-bar 620ms ease-out;
}

/* The global kill switch in globals.css already collapses these to a single
   0.001ms run, which lands on the resting state. This is the explicit version of
   the same promise: no motion at all, and the packet — the one element whose
   whole job is to move — is removed rather than parked. */
@media (prefers-reduced-motion: reduce) {
  .la-probe,
  .la-reveal,
  .la-bar {
    animation: none !important;
  }

  .la-packet {
    display: none !important;
  }
}
`;

/**
 * React hoists and de-duplicates a <style href> with a precedence, so every
 * figure can render this without the sheet appearing more than once.
 */
export function FigureMotion() {
  return (
    <style href="la-figure-motion" precedence="medium">
      {CSS}
    </style>
  );
}
