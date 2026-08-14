import { Composition } from "remotion";
import { IconTile } from "./IconTile.tsx";
import { ICON_PIXEL_SIZES, compositionId } from "./sizes.ts";

/**
 * One still per bitmap size macOS asks for. Not one 1024 still resized afterwards: the
 * mark is vector, so rendering each size natively puts every stroke on its own pixel grid
 * — and it lets the 16/32/64px tiles carry the simplified artwork (see IconTile.tsx).
 */
export function IconCompositions() {
  return (
    <>
      {ICON_PIXEL_SIZES.map((px) => (
        <Composition
          key={px}
          id={compositionId(px)}
          component={IconTile}
          defaultProps={{ px }}
          durationInFrames={1}
          fps={30}
          width={px}
          height={px}
        />
      ))}
    </>
  );
}
