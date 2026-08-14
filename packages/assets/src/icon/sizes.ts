/**
 * Every pixel size macOS needs and the exact `.iconset` filenames `iconutil` accepts.
 *
 * Apple's set is expressed in *points* at 1x and 2x, not in pixels: the 64px bitmap is
 * `icon_32x32@2x.png`, and there is no `icon_1024x1024.png` — the 1024px bitmap is
 * `icon_512x512@2x.png`. One wrong name makes iconutil reject the whole directory, which
 * is why this table is the part of the icon pipeline worth unit testing.
 */

export type IconsetEntry = {
  /** Filename inside the .iconset directory. */
  file: string;
  /** Bitmap size in real pixels — what we actually render. */
  px: number;
  /** Logical size in points. */
  point: number;
  scale: 1 | 2;
};

const POINTS = [16, 32, 128, 256, 512] as const;

export const ICONSET_ENTRIES: IconsetEntry[] = POINTS.flatMap((point) =>
  ([1, 2] as const).map((scale) => ({
    file: `icon_${point}x${point}${scale === 2 ? "@2x" : ""}.png`,
    px: point * scale,
    point,
    scale,
  })),
);

/** The distinct bitmaps to render, ascending: 16, 32, 64, 128, 256, 512, 1024. */
export const ICON_PIXEL_SIZES: number[] = [...new Set(ICONSET_ENTRIES.map((e) => e.px))].sort(
  (a, b) => a - b,
);

/** Remotion composition id for a bitmap size. Keep it derivable: the render script
 *  builds the command line from the same table the compositions are registered from. */
export function compositionId(px: number): string {
  return `AppIcon${px}`;
}
