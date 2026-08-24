import { PatchbayFigure } from "./PatchbayFigure.tsx";
import { heroAssets } from "./hero-assets.ts";

/**
 * The hero visual, in three graceful degradations:
 *   video present  -> autoplaying loop, with the still swapped in under reduced motion
 *   still only     -> the still
 *   nothing        -> the static patchbay figure, which says the same thing in markup
 *
 * The descriptions quote the hostname the render actually shows (`shop.test`, from
 * packages/assets/src/hero/script.ts). If the render changes TLD, these change with it — alt
 * text naming a suffix the app refuses would teach a name that cannot be created.
 */
export function HeroMedia() {
  const { webm, mp4, poster, still } = heroAssets();
  const hasVideo = Boolean(webm ?? mp4);

  if (!hasVideo && !still) {
    return <PatchbayFigure />;
  }

  if (!hasVideo && still) {
    return (
      <img
        src={still}
        alt="shop.test patched by a live cable to the dev server on port 3000"
        className="block w-full border border-hairline"
      />
    );
  }

  return (
    <>
      <video
        className="motion-only block w-full border border-hairline"
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        poster={poster ?? undefined}
        aria-label="localhost:3000 becoming shop.test, then a patch cable connecting it to the running server"
      >
        {webm ? <source src={webm} type="video/webm" /> : null}
        {mp4 ? <source src={mp4} type="video/mp4" /> : null}
      </video>

      {/* Reduced motion: the static, which states the swap the video acts out. */}
      {still ? (
        <picture className="reduced-only">
          <img
            src={still}
            alt="shop.test patched by a live cable to the dev server on port 3000"
            className="block w-full border border-hairline"
          />
        </picture>
      ) : (
        <div className="reduced-only">
          <PatchbayFigure />
        </div>
      )}
    </>
  );
}
