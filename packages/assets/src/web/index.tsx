import { Composition } from "remotion";
import { IconTile } from "./IconTile.tsx";
import { OgCard } from "./OgCard.tsx";
import type { WebMarkVariant } from "./WebMark.tsx";

/**
 * One composition per output pixel size rather than one composition rendered at several
 * scales: the mark is vector, so every size is rendered natively onto its own pixel grid
 * instead of being resampled down from a bigger raster.
 *
 * `markFraction` and `variant` are optically tuned per tier, not constant:
 *  - 16 — the jack alone, near full bleed. The cable does not survive 11 pixels.
 *  - 32/48 — the full mark, still generously sized.
 *  - 180/192/512 — the full mark at conventional icon padding.
 *  - maskable-512 — Android crops maskable icons to a circle 80% of the tile's width. A
 *    square of side s fits inside that circle only while s <= 0.8/sqrt(2) = 0.566 of the
 *    tile, so the mark sits at 0.52 with room to spare.
 *
 * Every fraction is chosen so `round(px * markFraction)` is **even**. An odd mark inside an
 * even tile cannot be centred on the pixel grid: flex centring puts it on a half pixel, and
 * the ink lands one pixel off centre. At 16 that was visible as a favicon clipped flush
 * against its right and bottom edges while carrying a 1px margin at the left and top.
 */
const TILES: { id: string; px: number; markFraction: number; variant: WebMarkVariant }[] = [
  { id: "WebIcon16", px: 16, markFraction: 0.875, variant: "jack" }, // 14px
  { id: "WebIcon32", px: 32, markFraction: 0.88, variant: "full" },
  { id: "WebIcon48", px: 48, markFraction: 0.8333, variant: "full" }, // 40px
  { id: "WebIcon180", px: 180, markFraction: 0.68, variant: "full" },
  { id: "WebIcon192", px: 192, markFraction: 0.7, variant: "full" },
  { id: "WebIcon512", px: 512, markFraction: 0.7, variant: "full" },
  { id: "WebMaskable512", px: 512, markFraction: 0.52, variant: "full" },
];

export function WebCompositions() {
  return (
    <>
      {TILES.map(({ id, px, markFraction, variant }) => (
        <Composition
          key={id}
          id={id}
          component={IconTile}
          defaultProps={{ markFraction, variant }}
          durationInFrames={1}
          fps={30}
          width={px}
          height={px}
        />
      ))}
      <Composition
        id="OgCard"
        component={OgCard}
        durationInFrames={1}
        fps={30}
        width={1200}
        height={630}
      />
    </>
  );
}
