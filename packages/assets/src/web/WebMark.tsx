import { brand } from "../brand.ts";

export type WebMarkVariant = "full" | "jack";

/**
 * The mark, re-cut for small sizes.
 *
 * `Mark.tsx` is the UI glyph: a 1.2-weight hairline on a 22-unit grid with the ring at
 * 55% opacity. That is correct next to 13px text and wrong as an icon — at 16px the ring
 * is a 0.9px line at half opacity (invisible) and the cable's 2.3-radius elbow is
 * sub-pixel. Both variants here keep full opacity and roughly double stroke weight, and
 * both use the artwork's own bounding box as the viewBox so the mark fills whatever tile
 * it is dropped into instead of floating in one corner the way the inline UI mark does.
 *
 * - "full" — the whole gesture: jack, cable, terminal dot. Legible from ~32px up.
 * - "jack" — the jack alone, scaled up to fill the same tile. At 16px there are only ~11
 *   pixels across the ring; spending four of them on a cable that lands sub-pixel turns
 *   the whole glyph into a smudge, so the smallest tier drops it and keeps the element
 *   that survives. Same idiom as the dashboard's StatusDot lamp.
 */
export function WebMark({
  size,
  variant = "full",
  color = brand.accent,
}: {
  size: number;
  variant?: WebMarkVariant;
  color?: string;
}) {
  if (variant === "jack") {
    return (
      <svg width={size} height={size} viewBox="1.2 1.2 13.6 13.6" fill="none">
        <circle cx="8" cy="8" r="5.6" stroke={color} strokeWidth="2.4" />
        <circle cx="8" cy="8" r="2.4" fill={color} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0.7 1.4 22.9 21.3" fill="none">
      <circle cx="8" cy="15.4" r="6.2" stroke={color} strokeWidth="2.2" />
      <circle cx="8" cy="15.4" r="2.5" fill={color} />
      <path
        d="M14.2 15.4h4a2.8 2.8 0 0 0 2.8-2.8V6.6"
        stroke={color}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="21" cy="4" r="2.6" fill={color} />
    </svg>
  );
}
