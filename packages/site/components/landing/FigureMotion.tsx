/**
 * Motion for the homepage graphics, shipped with them rather than in globals.css
 * so the figures stay one self-contained unit.
 *
 * The rule every keyframe below obeys: **the markup already paints the still
 * picture, and an animation only deviates from it.** Nothing is positioned,
 * revealed or coloured by JavaScript, so with scripting off, with animations
 * killed, or on the very first painted frame, a reader sees the same legible
 * diagram. That is also why the reduced-motion block can simply say
 * `animation: none` — the resting state *is* the fallback.
 */
const CSS = `
/* The hero's left-hand side: one port replaced by the next, hard cut rather than
   crossfaded, because that is what actually happens to a port number. Four share
   one 8s cycle on 2s delays, so exactly one is on screen at a time. At rest the
   first one is simply the one showing — nothing overlaps. */
@keyframes la-port {
  0%, 25% {
    opacity: 1;
  }
  25.01%, 100% {
    opacity: 0;
  }
}

.la-port {
  grid-area: 1 / 1;
  opacity: 0;
  animation: la-port 8s linear infinite;
}

.la-port:first-child {
  opacity: 1;
}

/* A request falling down the chain: it leaves the jack above, arrives at the one
   below and fades. 7px in at each end, so it starts and stops exactly on the
   jacks the rail draws. Invisible at rest, so a frozen frame is just the cable. */
@keyframes la-drop {
  0% {
    top: 7px;
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  58% {
    top: calc(100% - 7px);
    opacity: 1;
  }
  72%, 100% {
    top: calc(100% - 7px);
    opacity: 0;
  }
}

.la-drop {
  position: absolute;
  left: 50%;
  top: 7px;
  width: 5px;
  height: 5px;
  margin-top: -2.5px;
  margin-left: -2.5px;
  border-radius: 9999px;
  background: var(--live);
  opacity: 0;
  animation: la-drop 2.6s linear infinite;
}

/* A browser tab being clicked, then let go of. Four tabs share one 6s cycle on
   staggered delays, so exactly one is "open" at a time and the scan reads as
   hunting rather than as a light show. Resting state: none of them highlighted,
   which is the point the tile is making. */
@keyframes la-probe {
  0%, 4% {
    border-color: var(--hairline);
    background: var(--sunken);
    color: var(--muted);
  }
  9%, 20% {
    border-color: var(--hairline-strong);
    background: var(--raised);
    color: var(--ink);
  }
  25%, 100% {
    border-color: var(--hairline);
    background: var(--sunken);
    color: var(--muted);
  }
}

.la-probe {
  animation: la-probe 6s ease-in-out infinite;
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
   the same promise: no motion at all, and the two elements whose whole job is to
   move — the falling packet and the cycling port — are removed or parked rather
   than left mid-flight. */
@media (prefers-reduced-motion: reduce) {
  .la-probe,
  .la-reveal,
  .la-bar,
  .la-port {
    animation: none !important;
  }

  .la-drop {
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
