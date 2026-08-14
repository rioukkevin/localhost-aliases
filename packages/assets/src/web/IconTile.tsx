import { AbsoluteFill, useVideoConfig } from "remotion";
import { brand } from "../brand.ts";
import { WebMark, type WebMarkVariant } from "./WebMark.tsx";

export type IconTileProps = {
  /** Mark width as a fraction of the tile. Small tiles need more of it; maskable needs less. */
  markFraction: number;
  variant: WebMarkVariant;
};

/**
 * Every web icon is the same tile: flat canvas, accent mark, square corners. The platforms
 * that want rounded corners (iOS, Android launchers) apply their own mask, and the ones
 * that do not (browser tabs) look right square — which is also what DESIGN.md asks for.
 */
export function IconTile({ markFraction, variant }: IconTileProps) {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        background: brand.canvas,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <WebMark size={Math.round(width * markFraction)} variant={variant} />
    </AbsoluteFill>
  );
}
