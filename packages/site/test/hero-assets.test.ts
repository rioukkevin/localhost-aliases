import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heroAssets } from "../components/landing/hero-assets.ts";

const dirs: string[] = [];

function publicDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "la-site-hero-"));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("heroAssets", () => {
  test("is all null when nothing has been rendered yet", () => {
    expect(heroAssets(publicDir([]))).toEqual({
      webm: null,
      mp4: null,
      poster: null,
      still: null,
    });
  });

  test("maps each present file to its public path", () => {
    const assets = heroAssets(publicDir(["hero.webm", "hero.mp4", "hero-poster.png"]));
    expect(assets.webm).toBe("/hero.webm");
    expect(assets.mp4).toBe("/hero.mp4");
    expect(assets.poster).toBe("/hero-poster.png");
  });

  test("falls back to the poster as the reduced-motion still", () => {
    expect(heroAssets(publicDir(["hero-poster.png"])).still).toBe("/hero-poster.png");
  });

  test("prefers a dedicated still over the poster when both exist", () => {
    expect(heroAssets(publicDir(["hero-poster.png", "hero-static.png"])).still).toBe(
      "/hero-static.png",
    );
  });

  test("reports a partial render honestly instead of guessing", () => {
    const assets = heroAssets(publicDir(["hero.mp4"]));
    expect(assets.mp4).toBe("/hero.mp4");
    expect(assets.webm).toBeNull();
    expect(assets.poster).toBeNull();
  });
});
