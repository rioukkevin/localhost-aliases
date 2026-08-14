/**
 * The only file that talks to Vercel Blob.
 *
 * Everything above it depends on the `BlobClient` interface, never on `@vercel/blob`, so the
 * publish logic can be unit-tested with no token and no network.
 *
 * Paths are written with `addRandomSuffix: false`, which is what makes
 * `${NEXT_PUBLIC_BLOB_BASE_URL}/releases/latest.json` a URL the site can hardcode.
 */

import { list, put, type PutCommandOptions } from "@vercel/blob";

export interface PutResult {
  url: string;
  pathname: string;
}

export interface BlobClient {
  /** The blob's contents, or null when it does not exist yet (the very first release). */
  readText(pathname: string): Promise<string | null>;
  putJson(pathname: string, value: unknown, maxAgeSeconds: number): Promise<PutResult>;
  putFile(pathname: string, filePath: string, contentType: string): Promise<PutResult>;
}

/** A year: a DMG at a versioned path never changes, so caching it hard is free. */
export const IMMUTABLE_MAX_AGE = 31_536_000;

function putOptions(token: string, contentType: string, maxAgeSeconds: number): PutCommandOptions {
  const options: PutCommandOptions = {
    token,
    access: "public",
    addRandomSuffix: false,
    contentType,
    cacheControlMaxAge: maxAgeSeconds,
  };
  // @vercel/blob 0.27 overwrites an existing pathname by default and ignores keys it does not
  // know; 1.x refuses to overwrite without this flag. Setting it keeps a dependency bump from
  // turning every re-publish into a hard failure.
  (options as unknown as Record<string, unknown>).allowOverwrite = true;
  return options;
}

export function createBlobClient(token: string): BlobClient {
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is empty");

  return {
    async readText(pathname) {
      // `list` by prefix rather than `head`: it needs only the token, so reading the previous
      // manifest does not depend on knowing the store's public base URL.
      const { blobs } = await list({ token, prefix: pathname, limit: 100 });
      const hit = blobs.find((blob) => blob.pathname === pathname);
      if (!hit) return null;

      const response = await fetch(hit.url, { headers: { "cache-control": "no-cache" } });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`GET ${hit.url} answered ${response.status} ${response.statusText}`);
      }
      return await response.text();
    },

    async putJson(pathname, value, maxAgeSeconds) {
      const body = `${JSON.stringify(value, null, 2)}\n`;
      const result = await put(pathname, body, putOptions(token, "application/json", maxAgeSeconds));
      return { url: result.url, pathname: result.pathname };
    },

    async putFile(pathname, filePath, contentType) {
      const file = Bun.file(filePath);
      if (!(await file.exists())) throw new Error(`${filePath} does not exist`);
      // Bun.file is a lazy Blob, so a 250 MB DMG is streamed rather than held in memory.
      // multipart uploads it in parallel chunks and retries the ones that fail.
      const result = await put(pathname, file, {
        ...putOptions(token, contentType, IMMUTABLE_MAX_AGE),
        multipart: true,
      });
      return { url: result.url, pathname: result.pathname };
    },
  };
}
