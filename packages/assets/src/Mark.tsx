import { brand } from "./brand.ts";

/**
 * The product mark: a patch jack with a cable leaving it, lifted verbatim from the
 * dashboard's AppMark (22x22 viewBox) so the icon, the favicon and the UI are one mark.
 * `stroke` scales with the viewBox, so this stays legible from 16px to 1024px.
 */
export function Mark({
  size = 1024,
  color = brand.accent,
  opacity = 1,
}: {
  size?: number;
  color?: string;
  opacity?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" style={{ opacity }}>
      <circle cx="7" cy="11" r="5.5" stroke={color} strokeWidth="1.2" opacity="0.55" />
      <circle cx="7" cy="11" r="2" fill={color} />
      <path d="M12.5 11h3.2a2.3 2.3 0 0 0 2.3-2.3V4.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="18" cy="3" r="1.6" fill={color} />
    </svg>
  );
}
