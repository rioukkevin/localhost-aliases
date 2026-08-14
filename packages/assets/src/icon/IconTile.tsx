import { AbsoluteFill } from "remotion";
import { brand } from "../brand.ts";
import { Mark } from "../Mark.tsx";
import { squirclePath } from "./squircle.ts";

/**
 * The macOS app icon.
 *
 * Everything is authored on Apple's 1024 grid and emitted as one SVG, so a 16px bitmap is
 * rendered natively at 16px rather than resampled down from a big one.
 *
 * Two pieces of Apple geometry are non-negotiable:
 *  - the body is a squircle, not a circle and not a rounded rect (see squircle.ts);
 *  - it leaves a transparent margin. An icon drawn edge to edge looks oversized next to
 *    every other icon in the Dock or in Finder.
 */

const GRID = 1024;
const CENTRE = GRID / 2;

/** Apple's template: the icon body is 824 of the 1024 canvas. */
const TILE_LARGE = 824;
/**
 * Small bitmaps carry less margin — the restraint that reads as poise at 512px reads as a
 * shrunken smudge at 16px — and 0.875 puts the tile edge on a whole device pixel at both
 * 16px (14px tile) and 32px (28px tile), which the 0.8047 ratio does not.
 */
const TILE_SMALL = GRID * 0.875;

/**
 * At and below this, Mark.tsx cannot be used: its 1.2-unit strokes and its 0.55-opacity
 * ring land under one device pixel and turn to grey mush. These sizes get artwork drawn
 * on the device pixel grid instead — Apple ships different drawings per size too.
 */
export const PIXEL_GRID_MAX_PX = 32;

/** Share of the tile width the mark's ink takes at the large sizes. */
const DETAIL_FILL = 0.62;

/**
 * Mark.tsx's ink, measured in its own 22x22 viewBox with stroke widths included: the ring
 * spans x 0.9..13.1 and y 5.4..16.6 (r 5.5 plus half of the 1.2 stroke), the cable reaches
 * x 18.6, and the end dot tops out at y 1.4. Centring on the viewBox instead of on this
 * box would sit the whole mark visibly low and left.
 */
const MARK_INK = { x: 0.9, y: 1.4, w: 18.7, h: 15.2 };

function detailLayout() {
  const unit = (TILE_LARGE * DETAIL_FILL) / MARK_INK.w; // grid px per mark unit
  return {
    size: 22 * unit,
    tx: CENTRE - (MARK_INK.x + MARK_INK.w / 2) * unit,
    ty: CENTRE - (MARK_INK.y + MARK_INK.h / 2) * unit,
    jack: {
      x: CENTRE - (MARK_INK.x + MARK_INK.w / 2) * unit + 7 * unit,
      y: CENTRE - (MARK_INK.y + MARK_INK.h / 2) * unit + 11 * unit,
    },
  };
}

/**
 * The 16px (and, doubled, 32px) drawing, authored in device pixels and blown up to the
 * 1024 grid so a "1" here is exactly one pixel at 16px and two at 32px.
 *
 * Every measurement lands on the grid. Three of them are the whole drawing:
 *
 *  - **The pin is a rect, not a circle.** An r=1 circle on an integer centre covers four
 *    pixels at ~78% each, so it renders as a dull olive smudge *dimmer than the ring* —
 *    the exact inverse of Mark.tsx, where the pin is the solid and the ring is the
 *    0.55-opacity one. A 2x2 rect is two whole pixels at full accent.
 *  - **The cable starts at x=11, one clear pixel past the ring's outer edge (x=10).**
 *    Butted against it (the ring's right wall and the cable's run painting the same
 *    pixel) the two fuse into a single 6px bar and the icon reads as a key, not a jack
 *    with a lead leaving it.
 *  - **The ink is a 12x8 box centred on the 16px canvas** — ring x 2..10 / y 4..12, elbow
 *    turning at x 13 and rising to y 4 — so all four margins are whole pixels and the
 *    drawing sits dead centre in the 14px tile instead of low and left.
 *
 * The terminal dot is dropped: at this size it cannot be told apart from the cable's own
 * end. The right-then-up elbow is kept — a ring with a plain diagonal reads as a
 * magnifying glass.
 */
const PIXEL_UNIT = GRID / 16;

function PixelMark() {
  return (
    <g transform={`scale(${PIXEL_UNIT})`} stroke={brand.accent} fill="none">
      <circle cx="6" cy="8" r="3" strokeWidth="2" />
      <rect x="5" y="7" width="2" height="2" fill={brand.accent} stroke="none" />
      <path d="M11 8h2V4" strokeWidth="2" strokeLinejoin="miter" />
    </g>
  );
}

export function IconTile({ px }: { px: number }) {
  const pixelGrid = px <= PIXEL_GRID_MAX_PX;
  const tile = pixelGrid ? TILE_SMALL : TILE_LARGE;
  const tilePath = squirclePath(CENTRE, tile / 2);
  const detail = detailLayout();
  // The glow sits under the jack, which carries the mark's optical weight.
  const jack = pixelGrid ? { x: 6 * PIXEL_UNIT, y: 8 * PIXEL_UNIT } : detail.jack;

  return (
    <AbsoluteFill>
      <svg width="100%" height="100%" viewBox={`0 0 ${GRID} ${GRID}`}>
        <defs>
          {/* Depth without inventing colours: the tile is brand.canvas lit from above by
              brand.raised and shaded below by plain black at low alpha. A few percent of
              tone, which is all it takes to stop it reading as a dead rectangle. */}
          <linearGradient id="tile-base" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={brand.raised} />
            <stop offset="1" stopColor={brand.canvas} />
          </linearGradient>
          <linearGradient id="tile-shade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.35" stopColor="rgb(0,0,0)" stopOpacity="0" />
            <stop offset="1" stopColor="rgb(0,0,0)" stopOpacity="0.5" />
          </linearGradient>
          {/* The hairline of the design language, standing in for a bevel. Stroked at
              double width and clipped, so only the inner half paints and the silhouette
              stays exactly on the squircle. */}
          <linearGradient id="tile-rim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgb(255,255,255)" stopOpacity="0.2" />
            <stop offset="0.55" stopColor="rgb(255,255,255)" stopOpacity="0.05" />
            <stop offset="1" stopColor="rgb(255,255,255)" stopOpacity="0.02" />
          </linearGradient>
          {/* Kept deliberately under the threshold where it reads as bloom. At 0.13 the
              128px bitmap doubled the luminance of the tile centre and the icon looked
              soft — a lit fog behind a flat mark, which is the opposite of the design's
              instrument-panel language. */}
          <radialGradient id="jack-glow">
            <stop offset="0" stopColor={brand.accent} stopOpacity="0.07" />
            <stop offset="1" stopColor={brand.accent} stopOpacity="0" />
          </radialGradient>
          <clipPath id="tile-clip">
            <path d={tilePath} />
          </clipPath>
        </defs>

        <path d={tilePath} fill="url(#tile-base)" />
        <g clipPath="url(#tile-clip)">
          <rect x="0" y="0" width={GRID} height={GRID} fill="url(#tile-shade)" />
          <circle cx={jack.x} cy={jack.y} r={tile * 0.4} fill="url(#jack-glow)" />
          {/* The rim is a large-size detail only. At 16px its 8-unit stroke is an eighth of
              a device pixel along the flat edges, but it pools in the four corner pixels
              where the squircle turns — four ~40/255 grey specks that read as dirt on the
              icon, not as a lit edge. */}
          {pixelGrid ? null : (
            <path d={tilePath} fill="none" stroke="url(#tile-rim)" strokeWidth="8" />
          )}
        </g>

        {pixelGrid ? (
          <PixelMark />
        ) : (
          <g transform={`translate(${detail.tx},${detail.ty})`}>
            <Mark size={detail.size} />
          </g>
        )}
      </svg>
    </AbsoluteFill>
  );
}
