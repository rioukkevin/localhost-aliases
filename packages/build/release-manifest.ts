/**
 * The release manifest CI writes to Vercel Blob and the site reads.
 *
 * The schema is frozen in docs/WEB.md. Nothing here touches the network or the filesystem, so
 * the part that can silently destroy a changelog — merging a new release into the existing
 * history — is a pure function with unit tests.
 */

export interface DmgAsset {
  url: string;
  filename: string;
  /** bytes */
  size: number;
  sha256: string;
}

export interface ReleaseEntry {
  /** semver, no leading v */
  version: string;
  tag: string;
  publishedAt: string;
  /** markdown */
  notes: string;
  minimumMacOS: string;
  dmg: DmgAsset;
}

export interface ReleaseManifest extends ReleaseEntry {
  /** Newest first. Always starts with the top-level release, so the changelog is self-contained. */
  releases: ReleaseEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toDmgAsset(value: unknown): DmgAsset | null {
  if (!isRecord(value)) return null;
  const url = str(value.url);
  const filename = str(value.filename);
  const sha256 = str(value.sha256);
  const size = typeof value.size === "number" && Number.isFinite(value.size) ? value.size : NaN;
  if (!url || !filename || !sha256 || Number.isNaN(size)) return null;
  return { url, filename, size, sha256 };
}

/**
 * Salvage one history entry. Deliberately lenient about the cosmetic fields: a past release
 * that lost its `notes` is still a release, and dropping it would rewrite history. Only a
 * version and a usable download make an entry meaningful, so only those are required.
 */
export function toReleaseEntry(value: unknown): ReleaseEntry | null {
  if (!isRecord(value)) return null;
  const version = str(value.version);
  const dmg = toDmgAsset(value.dmg);
  if (!version || !dmg) return null;
  return {
    version,
    tag: str(value.tag, `v${version}`),
    publishedAt: str(value.publishedAt),
    notes: str(value.notes),
    minimumMacOS: str(value.minimumMacOS),
    dmg,
  };
}

/** JSON.parse that answers `null` instead of throwing, for a manifest that may be anything. */
export function parseManifest(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The version a previously published manifest advertises, if it is legible at all. */
export function manifestVersion(previous: unknown): string | null {
  if (!isRecord(previous)) return null;
  const version = str(previous.version);
  return version || null;
}

/**
 * Every release recoverable from a previously published manifest, newest first.
 *
 * The manifest's own top-level release is folded in as well: it should already be `releases[0]`,
 * but if a hand-edited or half-written manifest omits it, prepending blindly would drop the
 * release that is currently being advertised.
 */
export function historyFrom(previous: unknown): ReleaseEntry[] {
  if (!isRecord(previous)) return [];
  const raw: unknown[] = [previous, ...(Array.isArray(previous.releases) ? previous.releases : [])];
  const out: ReleaseEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const entry = toReleaseEntry(candidate);
    if (!entry || seen.has(entry.version)) continue;
    seen.add(entry.version);
    out.push(entry);
  }
  return out;
}

/**
 * The manifest to publish: `entry` on top, then everything the previous manifest knew about.
 * Re-publishing a version replaces its old history entry rather than duplicating it.
 */
export function mergeManifest(entry: ReleaseEntry, previous: unknown): ReleaseManifest {
  const history = historyFrom(previous).filter((r) => r.version !== entry.version);
  return { ...entry, releases: [entry, ...history] };
}
