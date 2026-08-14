#!/usr/bin/env bun
/**
 * Publish a built DMG.
 *
 *   1. assert the git tag, package.json and the bundle's Info.plist all say the same version
 *   2. hash the DMG and cross-check it against the checksum CI computed independently
 *   3. upload it to `releases/LocalhostAliases-<version>.dmg`
 *   4. rewrite `releases/latest.json` with this release prepended to the existing history
 *
 * Usage:
 *   bun run packages/build/publish.ts --tag v2.1.0 --dmg dist/LocalhostAliases-2.1.0.dmg \
 *     [--app dist/LocalhostAliases.app] [--notes-file dist/RELEASE_NOTES.md] \
 *     [--expect-sha256 <hex>] [--out dist/latest.json] [--allow-downgrade] [--dry-run]
 *
 * --dry-run touches no network at all: it prints the manifest that would be written, which is
 * the only way to exercise this script outside CI.
 */

import { appendFile } from "node:fs/promises";
import { basename } from "node:path";
import type { BlobClient } from "./blob-upload.ts";
import {
  compareSemver,
  assertVersionsMatch,
  plistValue,
  versionFromTag,
} from "./version-check.ts";
import {
  manifestVersion,
  mergeManifest,
  parseManifest,
  type ReleaseEntry,
  type ReleaseManifest,
} from "./release-manifest.ts";

/** Frozen in docs/WEB.md — the site reads this exact path. */
export const MANIFEST_PATH = "releases/latest.json";
export const DMG_CONTENT_TYPE = "application/x-apple-diskimage";
/** latest.json is overwritten by every release, so it must not sit in a CDN for long. */
export const MANIFEST_MAX_AGE = 60;

export function dmgPathname(filename: string): string {
  return `releases/${filename}`;
}

export function dmgFilename(version: string): string {
  return `LocalhostAliases-${version}.dmg`;
}

export interface PublishInput {
  version: string;
  tag: string;
  notes: string;
  minimumMacOS: string;
  /** Local path to the DMG. */
  dmgPath: string;
  filename: string;
  size: number;
  sha256: string;
  publishedAt: string;
  allowDowngrade?: boolean;
}

export interface PublishResult {
  manifest: ReleaseManifest;
  dmgUrl: string;
  manifestUrl: string;
  /** True when no previous manifest existed. */
  firstRelease: boolean;
}

/**
 * Everything that decides *what* gets written, with the network behind `blob`.
 *
 * The previous manifest is read before anything is uploaded, so a downgrade or an unreachable
 * store fails before a 250 MB upload rather than after it.
 */
export async function publish(input: PublishInput, blob: BlobClient): Promise<PublishResult> {
  if (input.filename !== dmgFilename(input.version)) {
    throw new Error(
      `the DMG is named ${input.filename} but version ${input.version} must ship as ${dmgFilename(input.version)}`,
    );
  }

  const previousText = await blob.readText(MANIFEST_PATH);
  const previous = previousText === null ? null : parseManifest(previousText);
  if (previousText !== null && previous === null) {
    console.warn(
      `warning: ${MANIFEST_PATH} exists but is not valid JSON — publishing a fresh manifest, ` +
        "the previous changelog cannot be recovered from it",
    );
  }

  const previousVersion = manifestVersion(previous);
  if (previousVersion && compareSemver(previousVersion, input.version) > 0 && !input.allowDowngrade) {
    throw new Error(
      `${MANIFEST_PATH} already advertises ${previousVersion}, which is newer than ${input.version}. ` +
        "Publishing would tell every user to downgrade. Pass --allow-downgrade if that is deliberate.",
    );
  }

  const uploaded = await blob.putFile(dmgPathname(input.filename), input.dmgPath, DMG_CONTENT_TYPE);

  const entry: ReleaseEntry = {
    version: input.version,
    tag: input.tag,
    publishedAt: input.publishedAt,
    notes: input.notes,
    minimumMacOS: input.minimumMacOS,
    dmg: {
      url: uploaded.url,
      filename: input.filename,
      size: input.size,
      sha256: input.sha256,
    },
  };

  const manifest = mergeManifest(entry, previous);
  const written = await blob.putJson(MANIFEST_PATH, manifest, MANIFEST_MAX_AGE);

  return {
    manifest,
    dmgUrl: uploaded.url,
    manifestUrl: written.url,
    firstRelease: previousText === null,
  };
}

// --- I/O -------------------------------------------------------------------

/** Streamed, because the DMG is a quarter of a gigabyte. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path} does not exist`);
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = file.stream().getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    size += value.byteLength;
  }
  return { sha256: hasher.digest("hex"), size };
}

/** A client that answers as if the store were empty and swallows every write. */
export function dryRunClient(): BlobClient {
  const base = "https://dry-run.public.blob.vercel-storage.com";
  return {
    async readText() {
      return null;
    },
    async putJson(pathname) {
      return { url: `${base}/${pathname}`, pathname };
    },
    async putFile(pathname) {
      return { url: `${base}/${pathname}`, pathname };
    },
  };
}

function arg(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : Bun.argv[i + 1];
}

function flag(name: string): boolean {
  return Bun.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const tag = arg("tag");
  const dmgPath = arg("dmg");
  if (!tag || !dmgPath) {
    throw new Error("usage: publish.ts --tag v2.0.0 --dmg dist/LocalhostAliases-2.0.0.dmg [--dry-run]");
  }

  const root = new URL("../../", import.meta.url).pathname;
  const pkg = (await Bun.file(`${root}package.json`).json()) as { version?: string };

  const app = arg("app") ?? `${root}dist/LocalhostAliases.app`;
  const plist = `${app}/Contents/Info.plist`;
  const hasBundle = await Bun.file(plist).exists();
  const bundledVersion = hasBundle ? await plistValue(plist, "CFBundleShortVersionString") : undefined;

  const version = assertVersionsMatch({
    "git tag": versionFromTag(tag),
    "package.json": pkg.version,
    "Info.plist (CFBundleShortVersionString)": bundledVersion,
  });

  // The floor the app itself declares — never a number typed into a manifest by hand.
  const minimumMacOS = (hasBundle ? await plistValue(plist, "LSMinimumSystemVersion") : undefined) ?? "";
  if (!minimumMacOS) throw new Error(`cannot read LSMinimumSystemVersion from ${plist}`);

  const { sha256, size } = await hashFile(dmgPath);
  const expected = arg("expect-sha256");
  if (expected && expected.toLowerCase() !== sha256) {
    throw new Error(`checksum mismatch for ${dmgPath}:\n  computed: ${sha256}\n  expected: ${expected}`);
  }

  const notesFile = arg("notes-file");
  const notes = notesFile && (await Bun.file(notesFile).exists())
    ? (await Bun.file(notesFile).text()).trim()
    : "";

  const dryRun = flag("dry-run");
  const token = process.env.BLOB_READ_WRITE_TOKEN ?? "";
  if (!dryRun && !token) throw new Error("BLOB_READ_WRITE_TOKEN is not set");

  // Imported here, not at the top: the unit tests must never load the Blob SDK.
  const blob = dryRun
    ? dryRunClient()
    : (await import("./blob-upload.ts")).createBlobClient(token);

  const result = await publish(
    {
      version,
      tag: tag.replace(/^refs\/tags\//, ""),
      notes,
      minimumMacOS,
      dmgPath,
      filename: basename(dmgPath),
      size,
      sha256,
      publishedAt: new Date().toISOString(),
      allowDowngrade: flag("allow-downgrade"),
    },
    blob,
  );

  const out = arg("out");
  if (out) await Bun.write(out, `${JSON.stringify(result.manifest, null, 2)}\n`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(
      githubOutput,
      `dmg_url=${result.dmgUrl}\nmanifest_url=${result.manifestUrl}\nversion=${version}\n`,
    );
  }

  console.log(dryRun ? "dry run — nothing was uploaded" : "published");
  console.log(`  version      ${version} (${result.manifest.tag})`);
  console.log(`  dmg          ${result.dmgUrl}`);
  console.log(`  size         ${size} bytes`);
  console.log(`  sha256       ${sha256}`);
  console.log(`  minimumMacOS ${minimumMacOS}`);
  console.log(`  manifest     ${result.manifestUrl}`);
  console.log(`  history      ${result.manifest.releases.length} release(s)${result.firstRelease ? " (first)" : ""}`);
  if (dryRun) console.log(JSON.stringify(result.manifest, null, 2));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
