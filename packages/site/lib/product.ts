/**
 * Facts about the build, in one place, so the download page, the changelog's empty state and
 * the FAQ cannot drift from each other or from the repository.
 *
 * Sources, all checked rather than remembered:
 *   apps/tray/Makefile        `-target arm64-apple-macos13.0` — arm64 only, no universal build
 *   apps/tray/Info.plist      LSMinimumSystemVersion 13.0
 *   packages/build/sign.sh    signing needs a Developer ID identity; `make bundle` alone is unsigned
 *   packages/build/install-local.sh  strips com.apple.quarantine from a locally built app
 */

/** The Swift deployment target and the Info.plist minimum, which are the same number. */
export const MINIMUM_MACOS = "13.0";
export const MINIMUM_MACOS_NAME = "Ventura";

/** There is no x86_64 slice and no universal binary. An Intel Mac cannot run this. */
export const ARCHITECTURE = "Apple Silicon (arm64)";

/**
 * The only supported way to get the app today. `make install` copies the bundle and removes
 * the quarantine attribute, which is why a source build never meets Gatekeeper.
 */
export const SOURCE_BUILD = [
  "git clone https://github.com/rioukkevin/localhost-aliases.git",
  "cd localhost-aliases",
  "bun install",
  "make bundle    # builds dist/LocalhostAliases.app",
  "make install   # copies it into /Applications",
].join("\n");

export const SOURCE_BUILD_REQUIREMENTS = "Bun 1.2.5 or later and the Xcode command line tools (swiftc).";

/**
 * What a careful reader should run on a downloaded app rather than take our word for. These
 * are the same three commands CI runs against its own artifact.
 */
export function verifyCommands(filename: string): string {
  return [
    `shasum -a 256 ${filename}`,
    "spctl -a -vvv -t install /Volumes/Localhost\\ Aliases/LocalhostAliases.app",
    "xcrun stapler validate /Volumes/Localhost\\ Aliases/LocalhostAliases.app",
  ].join("\n");
}

/** `shasum -c` reads the sidecar directly; this is the one-liner for the value on the page. */
export function checksumCommand(filename: string): string {
  return `shasum -a 256 ${filename}`;
}
