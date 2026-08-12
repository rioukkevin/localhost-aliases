/**
 * Where everything lives, in each of the two ways this product runs.
 *
 * `dev`    — a git checkout: `bun` off $PATH, TypeScript sources, `bun --bun next start`.
 * `bundle` — the installed `LocalhostAliases.app`: an embedded Bun runtime, a compiled
 *            helper, and a Next.js standalone build, none of which need a checkout.
 *
 * This is the single implementation of the frozen layout table in docs/PHASE4.md; the tray
 * has a line-for-line Swift mirror in `apps/tray/Sources/RuntimeLayout.swift`. Nothing else
 * may hard-code a bundle path, and nothing may assume a checkout exists.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HELPER_LABEL } from "./paths.ts";

export type RuntimeMode = "dev" | "bundle";

/** How the privileged helper got installed — drives the wording of the dashboard banner. */
export type HelperInstallMethod = "bundle" | "script";

/** Name of the daemon plist inside `Contents/Library/LaunchDaemons/`. `SMAppService.daemon` takes exactly this string. */
export const HELPER_PLIST_NAME = `${HELPER_LABEL}.plist`;

/** Basenames inside the bundle. They are part of the layout contract, not preferences. */
export const BUNDLE_TRAY_EXECUTABLE = "LocalhostAliases";
export const BUNDLE_HELPER_EXECUTABLE = "la-helper";
export const BUNDLE_BUN_EXECUTABLE = "bun";
/** Entry the embedded Bun runs; produced by `next build` with `output: "standalone"`. */
export const BUNDLE_WEB_ENTRY = "server.js";

/** Every path inside an installed `.app`, derived from its `Contents/` directory. */
export interface BundlePaths {
  contents: string;
  macOS: string;
  resources: string;
  /** The tray, i.e. `CFBundleExecutable`. */
  trayExecutable: string;
  /** The compiled root daemon. `BundleProgram` in the LaunchDaemon plist points here. */
  helperExecutable: string;
  /** The embedded Bun runtime. Signed separately from the outer bundle. */
  bunExecutable: string;
  /** Root of the Next.js standalone tree. */
  webRoot: string;
  /** The script the embedded Bun runs to serve the dashboard. */
  webEntry: string;
  launchDaemonsDir: string;
  helperPlist: string;
  infoPlist: string;
}

/**
 * The `.app/Contents` prefix of `path`, or null. Pure and path-only, so the packaging
 * scripts and the tests can reason about layouts that do not exist on this disk.
 */
export function bundleContentsFrom(path: string): string | null {
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i] === "Contents" && segments[i - 1]?.endsWith(".app") === true) {
      return segments.slice(0, i + 1).join("/");
    }
  }
  return null;
}

/** Expand a `Contents/` directory into the full layout. No filesystem access. */
export function bundlePathsFrom(contents: string): BundlePaths {
  const macOS = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  const launchDaemonsDir = join(contents, "Library", "LaunchDaemons");
  const webRoot = join(resources, "web");
  return {
    contents,
    macOS,
    resources,
    trayExecutable: join(macOS, BUNDLE_TRAY_EXECUTABLE),
    helperExecutable: join(macOS, BUNDLE_HELPER_EXECUTABLE),
    bunExecutable: join(resources, "bin", BUNDLE_BUN_EXECUTABLE),
    webRoot,
    webEntry: join(webRoot, BUNDLE_WEB_ENTRY),
    launchDaemonsDir,
    helperPlist: join(launchDaemonsDir, HELPER_PLIST_NAME),
    infoPlist: join(contents, "Info.plist"),
  };
}

/**
 * `Contents/` of the bundle this process runs inside, or null in a checkout.
 *
 * `LA_RUNTIME=dev` forces dev — it is how a developer runs the real `.app` against a
 * checkout. `LA_BUNDLE_CONTENTS` forces the opposite and is what the packaging tests use.
 *
 * The candidate paths are the executables macOS can start us as: the embedded Bun (web
 * server), the compiled helper (daemon), or the tray. A path match alone is not enough —
 * a checkout could sit inside some unrelated `.app` — so the candidate only wins if an
 * `Info.plist` is actually there.
 */
export function bundleContents(): string | null {
  if (process.env.LA_RUNTIME === "dev") return null;

  const forced = process.env.LA_BUNDLE_CONTENTS;
  if (forced !== undefined && forced !== "") return forced;

  for (const candidate of [process.execPath, process.argv[1]]) {
    if (candidate === undefined || candidate === "") continue;
    const contents = bundleContentsFrom(candidate);
    if (contents !== null && existsSync(join(contents, "Info.plist"))) return contents;
  }
  return null;
}

export function runtimeMode(): RuntimeMode {
  return bundleContents() === null ? "dev" : "bundle";
}

/** The layout of the bundle we are running inside, or null in dev. */
export function bundlePaths(): BundlePaths | null {
  const contents = bundleContents();
  return contents === null ? null : bundlePathsFrom(contents);
}

/**
 * In a bundle the daemon is registered by `SMAppService` from the tray (one admin prompt,
 * revocable in System Settings). In a checkout it is still `sudo ./scripts/install.sh`.
 * The dashboard must never print a sudo command in bundle mode — see docs/PHASE4.md §2.
 */
export function helperInstallMethod(): HelperInstallMethod {
  return runtimeMode() === "bundle" ? "bundle" : "script";
}

/** Argv that starts the dashboard, or null in dev (where the package scripts own it). */
export function bundleWebCommand(paths: BundlePaths): string[] {
  return [paths.bunExecutable, paths.webEntry];
}
