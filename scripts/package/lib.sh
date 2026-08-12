#!/usr/bin/env bash
#
# Shared plumbing for scripts/package/*.
#
# Hard rule for everything in this directory: it never needs privileges and never writes
# outside $LA_BUILD_DIR. No sudo, no launchctl, no /Library, no keychain. Assembling an
# unsigned bundle must be safe to run on any machine, at any time.
#
# Sourced, not executed.

set -euo pipefail

PKG_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$PKG_SCRIPT_DIR/../.." && pwd -P)"

# Everything this pipeline produces. Gitignored; `make clean-bundle` removes it whole.
BUILD_DIR="${LA_BUILD_DIR:-$REPO_ROOT/build}"

APP_NAME="LocalhostAliases"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"

# The frozen layout of docs/PHASE4.md §1. Mirrored by packages/core/src/runtime-layout.ts
# and apps/tray/Sources/Runtime.swift — change all three or none.
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
LAUNCHDAEMONS_DIR="$CONTENTS/Library/LaunchDaemons"
BIN_DIR="$RESOURCES_DIR/bin"
WEB_DIR="$RESOURCES_DIR/web"

TRAY_EXECUTABLE="$MACOS_DIR/$APP_NAME"
HELPER_EXECUTABLE="$MACOS_DIR/la-helper"
BUN_EXECUTABLE="$BIN_DIR/bun"
WEB_ENTRY="$WEB_DIR/server.js"

HELPER_LABEL="dev.localhost-aliases.helper"
HELPER_PLIST="$LAUNCHDAEMONS_DIR/$HELPER_LABEL.plist"
BUNDLE_ID="dev.localhost-aliases.tray"

# Written by runtime.sh, read by the report at the end of bundle.sh.
BUN_VERSION_FILE="$RESOURCES_DIR/bun-version.txt"

if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""
fi

step() { printf '%s==>%s %s%s%s\n' "$C_DIM" "$C_OFF" "$C_BOLD" "$*" "$C_OFF"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
info() { printf '  %s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '  %s✗%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"
}

# The bun that builds the bundle and gets embedded in it. LA_BUN overrides.
find_bun() {
  if [ -n "${LA_BUN:-}" ]; then
    [ -x "$LA_BUN" ] || die "LA_BUN=$LA_BUN is not executable"
    printf '%s' "$LA_BUN"
    return
  fi
  command -v bun >/dev/null 2>&1 || die "bun not found; install it or set LA_BUN"
  command -v bun
}

human_size() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

# plutil -lint everything we generate: a malformed plist inside a .app fails at install
# time, in launchd, with a message nobody can act on.
lint_plist() {
  /usr/bin/plutil -lint "$1" >/dev/null || die "generated an invalid plist: $1"
  ok "plutil -lint $(basename "$1")"
}
