/**
 * The release manifest client.
 *
 * CI uploads `releases/latest.json` to Vercel Blob with `addRandomSuffix: false`, so the URL
 * is stable and the site can just read it. The manifest is REMOTE INPUT: it is validated
 * field by field before anything is rendered, and every failure mode — env var unset (local
 * dev), network error, non-200, malformed JSON, missing fields — resolves to `null` / `[]`
 * rather than throwing. Today nothing has been published at all, so that is the path the
 * whole site actually takes.
 */

export interface ReleaseAsset {
  url: string;
  filename: string;
  /** Bytes. */
  size: number;
  sha256: string;
}

export interface Release {
  /** Semver, no leading "v". */
  version: string;
  tag: string;
  /** ISO 8601. */
  publishedAt: string;
  /** Markdown release notes. May be empty. */
  notes: string;
  /** e.g. "13.0", or null when the manifest does not say. */
  minimumMacOS: string | null;
  dmg: ReleaseAsset;
}

/** How long a fetched manifest is reused before it is refetched. */
export const RELEASES_REVALIDATE_SECONDS = 300;

function manifestUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_BLOB_BASE_URL;
  if (typeof base !== "string" || base.trim() === "") return null;
  return `${base.trim().replace(/\/+$/, "")}/releases/latest.json`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Only http(s) survives. The URL ends up in an href, so a `javascript:` or `data:` value in
 * a remote file must never reach the DOM.
 */
function httpUrl(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? raw : null;
}

function parseAsset(value: unknown): ReleaseAsset | null {
  const dmg = record(value);
  if (dmg === null) return null;

  const url = httpUrl(dmg.url);
  const filename = str(dmg.filename);
  const sha256 = str(dmg.sha256);
  const size = dmg.size;
  if (url === null || filename === null || sha256 === null) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;

  return { url, filename, size, sha256 };
}

/**
 * `notes` and `minimumMacOS` are tolerated when absent — a release genuinely may have no
 * notes, and an older manifest may predate the field. Everything a download depends on is
 * required, because a half-rendered download button is worse than none.
 */
export function parseRelease(value: unknown): Release | null {
  const raw = record(value);
  if (raw === null) return null;

  const version = str(raw.version);
  const tag = str(raw.tag);
  const publishedAt = str(raw.publishedAt);
  const dmg = parseAsset(raw.dmg);
  if (version === null || tag === null || publishedAt === null || dmg === null) return null;

  return {
    version,
    tag,
    publishedAt,
    notes: typeof raw.notes === "string" ? raw.notes : "",
    minimumMacOS: str(raw.minimumMacOS),
    dmg,
  };
}

/**
 * The manifest's top level IS the latest release; `releases` is the history for the
 * changelog. The latest is folded in and duplicates are dropped by version, so a manifest
 * that omits itself from its own history still produces a complete changelog.
 */
export function parseManifest(value: unknown): { latest: Release | null; all: Release[] } {
  const latest = parseRelease(value);
  const raw = record(value);
  const history = raw !== null && Array.isArray(raw.releases) ? raw.releases : [];

  const all: Release[] = [];
  const seen = new Set<string>();
  for (const candidate of [latest, ...history.map(parseRelease)]) {
    if (candidate === null || seen.has(candidate.version)) continue;
    seen.add(candidate.version);
    all.push(candidate);
  }

  return { latest, all };
}

/** Fetch + parse. Never throws; every failure is an empty manifest. */
async function loadManifest(): Promise<{ latest: Release | null; all: Release[] }> {
  const empty = { latest: null, all: [] as Release[] };
  const url = manifestUrl();
  if (url === null) return empty;

  try {
    // `next.revalidate` keeps the page off the network on every request while still letting
    // a freshly published release appear without a redeploy.
    const init = { next: { revalidate: RELEASES_REVALIDATE_SECONDS } } as RequestInit;
    const response = await fetch(url, init);
    if (!response.ok) return empty;
    return parseManifest(await response.json());
  } catch {
    return empty;
  }
}

export async function getLatestRelease(): Promise<Release | null> {
  return (await loadManifest()).latest;
}

export async function getAllReleases(): Promise<Release[]> {
  return (await loadManifest()).all;
}

// --- presentation helpers (pure, so they are unit-testable) -----------------

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${Math.round(bytes / 1000)} kB`;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** Stable across server and client: no locale, no timezone drift. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
