#!/usr/bin/env bun
/**
 * The version the tag advertises must be the version inside the binary. A DMG called 2.1.0 that
 * reports 2.0.0 in its Info.plist is the kind of thing nobody notices until a user reports it,
 * so CI asserts it — once early against package.json, again after the bundle exists.
 *
 *   bun run packages/build/version-check.ts --tag v2.1.0 [--app dist/LocalhostAliases.app]
 *
 * Prints the bare version, and appends `version=<v>` to $GITHUB_OUTPUT when running in Actions.
 */

import { appendFile } from "node:fs/promises";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `refs/tags/v2.0.0`, `v2.0.0` and `2.0.0` all mean the version `2.0.0`. */
export function versionFromTag(ref: string): string {
  const tag = ref.trim().replace(/^refs\/tags\//, "");
  const version = tag.replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`"${ref}" is not a release tag — expected refs/tags/vMAJOR.MINOR.PATCH`);
  }
  return version;
}

/**
 * All named sources must agree. Sources whose value is undefined are skipped: not every caller
 * has a built bundle to read yet.
 */
export function assertVersionsMatch(sources: Record<string, string | undefined>): string {
  const present = Object.entries(sources).filter((pair): pair is [string, string] => Boolean(pair[1]));
  if (present.length === 0) throw new Error("no versions to compare");

  const [, expected] = present[0] as [string, string];
  const disagree = present.filter(([, value]) => value !== expected);
  if (disagree.length > 0) {
    const detail = present.map(([name, value]) => `  ${name}: ${value}`).join("\n");
    throw new Error(`version mismatch — the tag and the shipped binary disagree:\n${detail}`);
  }
  return expected;
}

function comparePrerelease(a: string, b: string): number {
  // A version without a prerelease outranks one with it: 2.0.0 > 2.0.0-rc.1.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln < rn ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1. Build metadata is ignored, as semver requires. */
export function compareSemver(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) throw new Error(`cannot compare "${a}" with "${b}" — not both semver`);
  for (let i = 1; i <= 3; i++) {
    const l = Number(left[i]);
    const r = Number(right[i]);
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePrerelease(left[4] ?? "", right[4] ?? "");
}

// --- CLI -------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : Bun.argv[i + 1];
}

/** CFBundleShortVersionString out of a built bundle, via plutil (macOS only). */
export async function plistValue(plistPath: string, key: string): Promise<string | undefined> {
  const proc = Bun.spawn(["plutil", "-extract", key, "raw", "-o", "-", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return undefined;
  return out.trim() || undefined;
}

async function main(): Promise<void> {
  const tag = arg("tag");
  if (!tag) throw new Error("usage: version-check.ts --tag v2.0.0 [--app dist/LocalhostAliases.app]");

  const root = new URL("../../", import.meta.url).pathname;
  const pkg = (await Bun.file(`${root}package.json`).json()) as { version?: string };

  const app = arg("app");
  const plist = app ? `${app}/Contents/Info.plist` : undefined;
  const bundled = plist && (await Bun.file(plist).exists())
    ? await plistValue(plist, "CFBundleShortVersionString")
    : undefined;
  if (plist && !bundled && (await Bun.file(plist).exists())) {
    throw new Error(`${plist} has no CFBundleShortVersionString`);
  }

  const version = assertVersionsMatch({
    "git tag": versionFromTag(tag),
    "package.json": pkg.version,
    "Info.plist (CFBundleShortVersionString)": bundled,
  });

  const out = process.env.GITHUB_OUTPUT;
  if (out) await appendFile(out, `version=${version}\n`);
  console.log(version);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
