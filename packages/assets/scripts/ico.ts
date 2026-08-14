/**
 * A hand-rolled .ico writer. There is no ImageMagick here and the format is small:
 *
 *   ICONDIR      6 bytes   reserved u16=0 | type u16=1 (icon) | count u16
 *   ICONDIRENTRY 16 bytes  width u8 | height u8 | colours u8 | reserved u8 |
 *                          planes u16 | bpp u16 | bytesInRes u32 | imageOffset u32
 *   payloads               concatenated, in entry order
 *
 * All multi-byte fields are little-endian. Payloads are normally BMP DIBs, but a whole
 * PNG file is legal too and is what every browser we care about prefers — so we embed the
 * PNGs Remotion already produced rather than re-encoding anything.
 */

export const ICO_HEADER_BYTES = 6;
export const ICO_ENTRY_BYTES = 16;

export type IcoImage = { width: number; height: number; png: Uint8Array };

export function buildIco(images: IcoImage[]): Uint8Array {
  if (images.length === 0) throw new Error("an .ico needs at least one image");
  if (images.length > 0xffff) throw new Error(`too many images for one .ico: ${images.length}`);

  const directoryBytes = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * images.length;
  const total = images.reduce((n, img) => n + img.png.length, directoryBytes);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // 1 = icon (2 would be a cursor)
  view.setUint16(4, images.length, true);

  let offset = directoryBytes;
  images.forEach((img, i) => {
    const at = ICO_HEADER_BYTES + i * ICO_ENTRY_BYTES;
    out[at] = dimensionByte(img.width);
    out[at + 1] = dimensionByte(img.height);
    out[at + 2] = 0; // palette size: 0 = not paletted
    out[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, img.png.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });

  return out;
}

/** The field is one byte, and 256 — the largest legal icon — is encoded as 0. */
function dimensionByte(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 256) {
    throw new Error(`icon dimension must be an integer in 1..256, got ${n}`);
  }
  return n === 256 ? 0 : n;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read a PNG's real dimensions out of its IHDR instead of trusting the filename, so a
 * mis-sized render becomes a build error rather than a silently wrong directory entry.
 */
export function readPngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) throw new Error("not a PNG: too short");
  if (PNG_MAGIC.some((b, i) => png[i] !== b)) throw new Error("not a PNG: bad signature");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunkType = String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!);
  if (chunkType !== "IHDR") throw new Error(`not a PNG: first chunk is ${chunkType}, not IHDR`);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}
