import { describe, expect, test } from "bun:test";
import { ICO_ENTRY_BYTES, ICO_HEADER_BYTES, buildIco, readPngSize } from "./ico.ts";

/** A byte-exact PNG header (signature + IHDR) — enough for readPngSize, and unique per size. */
function fakePng(width: number, height: number, payloadBytes = 40): Uint8Array {
  const png = new Uint8Array(24 + payloadBytes);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(png.buffer);
  view.setUint32(8, 13, false); // IHDR length
  png.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  for (let i = 24; i < png.length; i++) png[i] = (width + i) % 256;
  return png;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

const entryAt = (i: number) => ICO_HEADER_BYTES + i * ICO_ENTRY_BYTES;

function image(size: number, payloadBytes?: number) {
  return { width: size, height: size, png: fakePng(size, size, payloadBytes) };
}

describe("buildIco header", () => {
  const ico = buildIco([image(16), image(32), image(48)]);

  test("reserved field is zero and the type is 1 (icon, not cursor)", () => {
    expect(u16(ico, 0)).toBe(0);
    expect(u16(ico, 2)).toBe(1);
  });

  test("image count matches what went in", () => {
    expect(u16(ico, 4)).toBe(3);
  });

  test("total length is exactly directory + payloads, with no slack", () => {
    const payloads = [16, 32, 48].reduce((n, s) => n + fakePng(s, s).length, 0);
    expect(ico.length).toBe(ICO_HEADER_BYTES + ICO_ENTRY_BYTES * 3 + payloads);
  });
});

describe("buildIco directory entries", () => {
  const sizes = [16, 32, 48];
  // Distinct payload lengths so a copy/paste offset bug cannot accidentally line up.
  const images = sizes.map((s, i) => image(s, 40 + i * 17));
  const ico = buildIco(images);

  test("each entry's offset and length point at that entry's payload", () => {
    images.forEach((img, i) => {
      const at = entryAt(i);
      const length = u32(ico, at + 8);
      const offset = u32(ico, at + 12);
      expect(length).toBe(img.png.length);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      expect(Array.from(ico.slice(offset, offset + length))).toEqual(Array.from(img.png));
    });
  });

  test("payloads start after the directory and never overlap", () => {
    const directoryBytes = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * images.length;
    let expected = directoryBytes;
    images.forEach((img, i) => {
      expect(u32(ico, entryAt(i) + 12)).toBe(expected);
      expected += img.png.length;
    });
    expect(expected).toBe(ico.length);
  });

  test("dimensions, planes and bit depth are written per entry", () => {
    sizes.forEach((size, i) => {
      const at = entryAt(i);
      expect(ico[at]).toBe(size);
      expect(ico[at + 1]).toBe(size);
      expect(ico[at + 2]).toBe(0); // not paletted
      expect(ico[at + 3]).toBe(0); // reserved
      expect(u16(ico, at + 4)).toBe(1); // planes
      expect(u16(ico, at + 6)).toBe(32); // bpp
    });
  });

  test("256 is encoded as 0, the format's only special case", () => {
    const ico256 = buildIco([image(256)]);
    expect(ico256[entryAt(0)]).toBe(0);
    expect(ico256[entryAt(0) + 1]).toBe(0);
  });
});

describe("buildIco rejects what it cannot encode", () => {
  test("no images", () => {
    expect(() => buildIco([])).toThrow(/at least one image/);
  });

  test("a dimension that does not fit in a byte", () => {
    expect(() => buildIco([{ width: 512, height: 512, png: fakePng(512, 512) }])).toThrow(/1\.\.256/);
    expect(() => buildIco([{ width: 0, height: 16, png: fakePng(16, 16) }])).toThrow(/1\.\.256/);
    expect(() => buildIco([{ width: 16.5, height: 16, png: fakePng(16, 16) }])).toThrow(/1\.\.256/);
  });
});

describe("readPngSize", () => {
  test("reads width and height out of the IHDR", () => {
    expect(readPngSize(fakePng(16, 16))).toEqual({ width: 16, height: 16 });
    expect(readPngSize(fakePng(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  test("reads a real rendered PNG when one is on disk", async () => {
    const file = Bun.file(new URL("../out/web/icon-32.png", import.meta.url).pathname);
    if (!(await file.exists())) return; // renders are not a prerequisite for the test suite
    expect(readPngSize(new Uint8Array(await file.arrayBuffer()))).toEqual({ width: 32, height: 32 });
  });

  test("rejects anything that is not a PNG", () => {
    expect(() => readPngSize(new Uint8Array(8))).toThrow(/too short/);
    expect(() => readPngSize(new Uint8Array(40))).toThrow(/bad signature/);
    const wrongChunk = fakePng(16, 16);
    wrongChunk.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT" where IHDR must be
    expect(() => readPngSize(wrongChunk)).toThrow(/not IHDR/);
  });
});
