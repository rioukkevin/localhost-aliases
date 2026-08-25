/**
 * The release source: the GitHub REST API for `rioukkevin/localhost-aliases`.
 *
 *   GET /repos/{owner}/{repo}/releases/latest  -> the download page and the hero button
 *   GET /repos/{owner}/{repo}/releases         -> the changelog
 *
 * Three things this file exists to guarantee:
 *
 * 1. IT NEVER THROWS. `null` / `[]` is a valid answer and today it is the REAL one: the repo
 *    has no tags and no releases, and unauthenticated the API answers 404 for both endpoints.
 *    Every page renders that state on purpose, so a 404, a 403 rate-limit (60 req/hr per IP
 *    unauthenticated), a network error, malformed JSON, a release with no `.dmg` attached or
 *    one whose body carries no checksum all resolve to the same quiet empty answer.
 * 2. IT VALIDATES BEFORE IT TRUSTS. A release body and an asset URL are remote input that
 *    ends up in a page; a `javascript:` asset URL or a 400kB body must not reach the DOM.
 * 3. IT DOES NOT BURN THE RATE LIMIT. Every request carries Next's `revalidate` (300s) so a
 *    build or a burst of traffic reuses one response, and `GITHUB_TOKEN` is sent as a bearer
 *    when the environment has one (5000 req/hr instead of 60).
 */

import { MINIMUM_MACOS } from "./product.ts";

export const RELEASES_OWNER = "rioukkevin";
export const RELEASES_REPO = "localhost-aliases";

/** How long a fetched response is reused before it is refetched. */
export const RELEASES_REVALIDATE_SECONDS = 300;

/** How many releases the changelog asks for. One page is a lifetime of releases here. */
export const RELEASES_PAGE_SIZE = 30;

/**
 * A release body is remote text rendered into a page. GitHub allows 125_000 characters;
 * nothing legitimate here is close, so anything past this is truncated rather than rendered.
 */
export const MAX_NOTES_LENGTH = 20_000;

export interface ReleaseAsset {
  /** `browser_download_url`, proven to be http(s). */
  url: string;
  filename: string;
  /** Bytes. */
  size: number;
  /** Parsed out of the release body, which is where the publish step writes it. */
  sha256: string | null;
}

export interface Release {
  /** Semver-ish, the tag with a leading `v` stripped. */
  version: string;
  tag: string;
  /** ISO 8601, or `""` when GitHub has no publish date (an unpublished draft). */
  publishedAt: string;
  /** The release body, as markdown. May be empty. */
  notes: string;
  /** The release page on GitHub. */
  htmlUrl: string;
  prerelease: boolean;
  /**
   * The `.dmg` asset, or `null` when none is attached — a release whose upload failed, or a
   * notes-only tag. The pages show the version and the notes and no download button.
   */
  dmg: ReleaseAsset | null;
  /**
   * The macOS version the app requires (`lib/product.ts`, from `apps/tray/Info.plist`). It is
   * a property of the build, not of the API response, so it is a constant carried onto every
   * release rather than a field that could go missing.
   */
  minimumMacOS: string;
}

// --- transport --------------------------------------------------------------

/**
 * `GITHUB_API_BASE_URL` exists so the site can be run against a fixture of the API without a
 * network, which is how the download page is verified end to end. Unset — production — it is
 * the real API.
 */
function apiBase(): string {
  const raw = process.env.GITHUB_API_BASE_URL?.trim();
  return (raw !== undefined && raw !== "" ? raw : "https://api.github.com").replace(/\/+$/, "");
}

/** GitHub requires a User-Agent and rejects requests without one. */
export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": `${RELEASES_OWNER}-${RELEASES_REPO}-site`,
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * One GET. Any non-2xx — 404 (no releases, or a private repo seen anonymously), 403/429
 * (rate limit), 5xx — is `null`, and so is a transport failure or a body that is not JSON.
 */
async function getJson(path: string): Promise<unknown | null> {
  try {
    const init = {
      headers: githubHeaders(),
      next: { revalidate: RELEASES_REVALIDATE_SECONDS },
    } as RequestInit;
    const response = await fetch(`${apiBase()}${path}`, init);
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

// --- validation -------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Only http(s) survives. The URL ends up in an href, so a `javascript:` or `data:` value in a
 * remote payload must never reach the DOM.
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

/**
 * A tag is printed as a heading and pasted into a URL. Real tags are short and boring; a
 * value that is neither is treated as junk rather than escaped and hoped for.
 */
function tagName(value: unknown): string | null {
  const raw = str(value);
  if (raw === null || raw.length > 64) return null;
  return /^[A-Za-z0-9._+-]+$/.test(raw) ? raw : null;
}

/** `v2.0.0` -> `2.0.0`. Anything else is left exactly as tagged. */
export function versionFromTag(tag: string): string {
  return /^v\d/.test(tag) ? tag.slice(1) : tag;
}

const SHA256_LABELLED = /sha-?256[^0-9a-fA-F]{0,24}([0-9a-fA-F]{64})/i;
const SHA256_SHASUM_LINE = /^([0-9a-fA-F]{64})[ \t]+\*?\S+\.dmg[ \t]*$/m;

/**
 * The checksum lives in the release body — the publish step writes both a labelled line and a
 * `shasum -c`-shaped line, and either is accepted. Absence is "unknown", never a failure: a
 * release with no checksum still downloads, the page just cannot offer one to compare.
 */
export function parseSha256(notes: string): string | null {
  const match = SHA256_SHASUM_LINE.exec(notes) ?? SHA256_LABELLED.exec(notes);
  return match?.[1] !== undefined ? match[1].toLowerCase() : null;
}

/**
 * The first attached `.dmg`. Everything else on a release — the `.sha256` sidecar, source
 * tarballs GitHub adds itself — is ignored, and an asset missing a usable URL or size is
 * skipped rather than rendered half-formed.
 */
export function parseDmgAsset(assets: unknown, sha256: string | null): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;

  for (const candidate of assets) {
    const asset = record(candidate);
    if (asset === null) continue;

    const filename = str(asset.name);
    if (filename === null || !filename.toLowerCase().endsWith(".dmg")) continue;

    const url = httpUrl(asset.browser_download_url);
    if (url === null) continue;

    const size = asset.size;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;

    return { url, filename, size, sha256 };
  }
  return null;
}

/**
 * One item from either endpoint. Drafts are dropped outright: an authenticated token would
 * make the list endpoint return them, and an unpublished draft is not a download.
 */
export function parseRelease(value: unknown): Release | null {
  const raw = record(value);
  if (raw === null) return null;
  if (raw.draft === true) return null;

  const tag = tagName(raw.tag_name);
  if (tag === null) return null;

  const notes = typeof raw.body === "string" ? raw.body.slice(0, MAX_NOTES_LENGTH) : "";
  const sha256 = parseSha256(notes);

  return {
    version: versionFromTag(tag),
    tag,
    publishedAt: str(raw.published_at) ?? "",
    notes,
    htmlUrl:
      httpUrl(raw.html_url) ??
      `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/tag/${encodeURIComponent(tag)}`,
    prerelease: raw.prerelease === true,
    dmg: parseDmgAsset(raw.assets, sha256),
    minimumMacOS: MINIMUM_MACOS,
  };
}

/** The list endpoint's payload. A rotten entry is dropped; the rest survive. */
export function parseReleaseList(value: unknown): Release[] {
  if (!Array.isArray(value)) return [];

  const releases: Release[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const release = parseRelease(candidate);
    if (release === null || seen.has(release.tag)) continue;
    seen.add(release.tag);
    releases.push(release);
  }
  return releases;
}

// --- the two reads the pages make -------------------------------------------

/**
 * The newest published, non-prerelease release, or `null` when there is none. GitHub's
 * `/releases/latest` already excludes drafts and prereleases; it answers 404 when the repo has
 * never published one, which is exactly today's state.
 */
export async function getLatestRelease(): Promise<Release | null> {
  const path = `/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`;
  return parseRelease(await getJson(path));
}

/** Newest first, as GitHub returns them. Empty when there are none, or the API said no. */
export async function getAllReleases(): Promise<Release[]> {
  const path = `/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases?per_page=${RELEASES_PAGE_SIZE}`;
  return parseReleaseList(await getJson(path));
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
  if (iso === "") return "";
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
