import { IconCompositions } from "./icon/index.tsx";
import { WebCompositions } from "./web/index.tsx";
import { HeroCompositions } from "./hero/index.tsx";

/**
 * FROZEN registry. Three agents own one directory each and export exactly one
 * `*Compositions` fragment, so nobody has to edit this file and they cannot collide.
 */
export function RemotionRoot() {
  return (
    <>
      <IconCompositions />
      <WebCompositions />
      <HeroCompositions />
    </>
  );
}
