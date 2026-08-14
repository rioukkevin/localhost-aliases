/**
 * Site-only formatting. Size and date formatting live in lib/releases.ts next to the
 * manifest they describe; only the checksum shortening is needed here.
 */

/** First 12 hex characters — enough to compare by eye against `shasum -a 256`. */
export function shortSha(sha: string): string {
  return sha.trim().slice(0, 12);
}
