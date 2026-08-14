import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The hero video is rendered by packages/assets and copied into public/. It is not
 * committed yet, so the page resolves what actually exists on disk at build time
 * rather than shipping <video> tags and <img> tags that 404.
 */
export interface HeroAssets {
  webm: string | null;
  mp4: string | null;
  poster: string | null;
  /** Shown instead of the video under prefers-reduced-motion. */
  still: string | null;
}

export function heroAssets(publicDir: string = join(process.cwd(), "public")): HeroAssets {
  const has = (file: string) => (existsSync(join(publicDir, file)) ? `/${file}` : null);
  const poster = has("hero-poster.png");
  return {
    webm: has("hero.webm"),
    mp4: has("hero.mp4"),
    poster,
    still: has("hero-static.png") ?? poster,
  };
}
