#!/usr/bin/env bash
#
# bundle.sh — assemble build/LocalhostAliases.app, unsigned.
#
#   scripts/package/bundle.sh [--no-build] [--skip-tray] [--no-verify]
#
# Produces exactly the frozen layout of docs/PHASE4.md §1:
#
#   LocalhostAliases.app/Contents/
#   ├── Info.plist
#   ├── PkgInfo
#   ├── MacOS/LocalhostAliases                     the Swift tray
#   ├── MacOS/la-helper                            bun --compile of packages/helper
#   ├── Library/LaunchDaemons/…helper.plist        BundleProgram -> Contents/MacOS/la-helper
#   └── Resources/
#       ├── bin/bun                                embedded runtime
#       └── web/                                   next standalone + .next/static
#
# Unprivileged and self-contained: nothing outside build/ is written, nothing is signed,
# nothing is registered with launchd. Signing and notarisation are separate steps that
# consume this directory (docs/PHASE4.md §6).

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

BUILD_WEB=1
SKIP_TRAY=0
VERIFY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD_WEB=0; shift ;;
    --skip-tray) SKIP_TRAY=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

step "Assembling $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$BIN_DIR" "$WEB_DIR" "$LAUNCHDAEMONS_DIR"
ok "layout created"

# --- the tray, the bundle's main executable -------------------------------------------
if [ "$SKIP_TRAY" -eq 1 ]; then
  warn "--skip-tray: Contents/MacOS/$APP_NAME will be missing (the .app will not launch)"
else
  step "Building the tray"
  make -C "$REPO_ROOT/apps/tray" build >/dev/null || die "swiftc failed; see: make -C apps/tray build"
  TRAY_BIN="$REPO_ROOT/apps/tray/.build/$APP_NAME"
  [ -x "$TRAY_BIN" ] || die "missing $TRAY_BIN"
  cp "$TRAY_BIN" "$TRAY_EXECUTABLE"
  chmod 0755 "$TRAY_EXECUTABLE"
  ok "$TRAY_EXECUTABLE ($(human_size "$TRAY_EXECUTABLE"))"
fi

# --- the three payloads ----------------------------------------------------------------
"$PKG_SCRIPT_DIR/helper.sh"
"$PKG_SCRIPT_DIR/runtime.sh"
if [ "$BUILD_WEB" -eq 1 ]; then "$PKG_SCRIPT_DIR/web.sh"; else "$PKG_SCRIPT_DIR/web.sh" --no-build; fi
"$PKG_SCRIPT_DIR/plists.sh"

# --- the layout contract, asserted -----------------------------------------------------
step "Verifying the layout"
REQUIRED=(
  "$CONTENTS/Info.plist"
  "$HELPER_EXECUTABLE"
  "$BUN_EXECUTABLE"
  "$WEB_ENTRY"
  "$HELPER_PLIST"
)
[ "$SKIP_TRAY" -eq 1 ] || REQUIRED+=("$TRAY_EXECUTABLE")
for path in "${REQUIRED[@]}"; do
  [ -e "$path" ] || die "missing ${path#"$APP_BUNDLE/"}"
done
for path in "$HELPER_EXECUTABLE" "$BUN_EXECUTABLE"; do
  [ -x "$path" ] || die "not executable: ${path#"$APP_BUNDLE/"}"
done
ok "every path in the frozen layout is present"

step "Bundle"
printf '  %s\n' "$APP_BUNDLE"
printf '  total %s\n' "$(human_size "$APP_BUNDLE")"
du -sh "$MACOS_DIR"/* "$BIN_DIR"/bun "$WEB_DIR" 2>/dev/null | sed 's|'"$APP_BUNDLE"'/|  |'
find "$CONTENTS" -maxdepth 3 -not -path "*/Resources/web/*" | sed "s|$APP_BUNDLE|  LocalhostAliases.app|" | sort

if [ "$VERIFY" -eq 1 ]; then
  "$PKG_SCRIPT_DIR/verify-bundle.sh"
else
  info "verification skipped (--no-verify)"
fi
