import { Composition, Still } from "remotion";
import { Hero, HeroStill } from "./Hero.tsx";
import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from "./state.ts";

/**
 * FROZEN name — Root.tsx imports it.
 *
 * `Hero` is the loop; the poster is pulled from it at a settled frame. `HeroStatic` is the
 * separate prefers-reduced-motion image: a still cannot act out the swap over time, so it
 * has to show it in one frame.
 */
export function HeroCompositions() {
  return (
    <>
      <Composition
        id="Hero"
        component={Hero}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Still id="HeroStatic" component={HeroStill} width={WIDTH} height={HEIGHT} />
    </>
  );
}
