import { describe, expect, test } from "bun:test";
import {
  ICONSET_ENTRIES,
  ICON_PIXEL_SIZES,
  compositionId,
} from "../src/icon/sizes.ts";
import { squirclePath } from "../src/icon/squircle.ts";

/**
 * iconutil does not reject an unknown filename — it exits 0 and silently drops that size
 * from the icns. So the filename table is the only thing standing between a typo and an
 * app icon that quietly has no 64px artwork. It gets asserted literally, not derived.
 */
const APPLE_FILENAMES = [
  "icon_16x16.png",
  "icon_16x16@2x.png",
  "icon_32x32.png",
  "icon_32x32@2x.png",
  "icon_128x128.png",
  "icon_128x128@2x.png",
  "icon_256x256.png",
  "icon_256x256@2x.png",
  "icon_512x512.png",
  "icon_512x512@2x.png",
];

describe("iconset filenames", () => {
  test("are exactly Apple's ten names, in Apple's order", () => {
    expect(ICONSET_ENTRIES.map((e) => e.file)).toEqual(APPLE_FILENAMES);
  });

  test("are unique", () => {
    expect(new Set(ICONSET_ENTRIES.map((e) => e.file)).size).toBe(ICONSET_ENTRIES.length);
  });

  test("map every name to the bitmap size macOS expects behind it", () => {
    const byName = Object.fromEntries(ICONSET_ENTRIES.map((e) => [e.file, e.px]));
    expect(byName).toEqual({
      "icon_16x16.png": 16,
      "icon_16x16@2x.png": 32,
      "icon_32x32.png": 32,
      "icon_32x32@2x.png": 64,
      "icon_128x128.png": 128,
      "icon_128x128@2x.png": 256,
      "icon_256x256.png": 256,
      "icon_256x256@2x.png": 512,
      "icon_512x512.png": 512,
      "icon_512x512@2x.png": 1024,
    });
  });

  test("never spell a 2x bitmap as its own point size", () => {
    // icon_64x64.png and icon_1024x1024.png are the classic mistakes: both are real
    // bitmap sizes, and neither is a name iconutil understands.
    expect(APPLE_FILENAMES).not.toContain("icon_64x64.png");
    expect(APPLE_FILENAMES).not.toContain("icon_1024x1024.png");
  });

  test("agree with their own point size and scale", () => {
    for (const entry of ICONSET_ENTRIES) {
      expect(entry.px).toBe(entry.point * entry.scale);
      expect(entry.file).toBe(`icon_${entry.point}x${entry.point}${entry.scale === 2 ? "@2x" : ""}.png`);
    }
  });
});

describe("pixel sizes to render", () => {
  test("are the distinct bitmap sizes, ascending", () => {
    expect(ICON_PIXEL_SIZES).toEqual([16, 32, 64, 128, 256, 512, 1024]);
  });

  test("cover every iconset entry, with nothing rendered that is never used", () => {
    expect(new Set(ICON_PIXEL_SIZES)).toEqual(new Set(ICONSET_ENTRIES.map((e) => e.px)));
  });

  test("each get their own composition id", () => {
    const ids = ICON_PIXEL_SIZES.map(compositionId);
    expect(ids).toEqual([
      "AppIcon16",
      "AppIcon32",
      "AppIcon64",
      "AppIcon128",
      "AppIcon256",
      "AppIcon512",
      "AppIcon1024",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("squircle", () => {
  const path = squirclePath(512, 412);

  test("is a closed polygon of the requested resolution", () => {
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path.split("L").length).toBe(360); // M + 359 L commands
  });

  test("touches the tile edges but nothing outside them", () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const point of path.slice(1, -1).split("L")) {
      const [x, y] = point.split(",").map(Number);
      xs.push(x);
      ys.push(y);
    }
    expect(Math.min(...xs)).toBeCloseTo(100, 1);
    expect(Math.max(...xs)).toBeCloseTo(924, 1);
    expect(Math.min(...ys)).toBeCloseTo(100, 1);
    expect(Math.max(...ys)).toBeCloseTo(924, 1);
  });

  test("corners are Apple's continuous curve, not a circle and not a square", () => {
    // At 45 degrees a circle inscribed in the tile would be 412 from the centre and a
    // square corner 583. The macOS shape sits between: 507, which back-solves to a
    // ~182pt corner radius against the template's 185.4pt.
    const points = path.slice(1, -1).split("L").map((p) => p.split(",").map(Number));
    const diagonal = points
      .map(([x, y]) => ({ x, y, d: Math.hypot(x - 512, y - 512) }))
      .filter((p) => Math.abs(p.x - p.y) < 1);
    const corner = Math.max(...diagonal.map((p) => p.d));
    expect(corner).toBeGreaterThan(412 * 1.15);
    expect(corner).toBeLessThan(412 * 1.35);
  });
});
