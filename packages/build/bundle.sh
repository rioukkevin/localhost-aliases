#!/usr/bin/env bash
#
# Assemble the unsigned LocalhostAliases.app.
#
#   LocalhostAliases.app/Contents/
#   ├── Info.plist                  LSUIElement, dev.localhost-aliases.app
#   ├── MacOS/LocalhostAliases      Swift tray
#   └── Resources/
#       ├── bin/bun                 embedded Bun runtime (runs the dashboard)
#       ├── dashboard/              next standalone output (+ .next/static, + public)
#       ├── forwarder               bun --compile, runs as root
#       ├── mcp                     bun --compile, stdio MCP server
#       └── privileged/             apply.sh (the one privileged entrypoint), uninstall.sh,
#                                   lib.sh, and teardown.sh + self-delete.sh, which let the
#                                   installed app uninstall itself without any source tree
#
# The Swift tray and its Info.plist come from apps/tray's own Makefile.
#
# Env overrides: DIST.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

VERSION="$(app_version)"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"

step "Assembling $APP_NAME.app $VERSION"
rm -rf "$APP"

# --- Swift tray + Info.plist ------------------------------------------------
# apps/tray owns its own build and its own Info.plist (LSUIElement, dev.localhost-aliases.app);
# duplicating either here would let the two drift. Its `app` target deliberately leaves
# Contents/Resources alone, which is what the rest of this script fills.
step "Tray"
[ -f "$ROOT/apps/tray/Makefile" ] || die "apps/tray/Makefile is missing"
make -C "$ROOT/apps/tray" app APP="$APP" VERSION="$VERSION" | sed 's/^/    /'
[ -x "$CONTENTS/MacOS/$APP_NAME" ] || die "apps/tray did not produce Contents/MacOS/$APP_NAME"
plutil -lint "$CONTENTS/Info.plist" >/dev/null || die "apps/tray/Info.plist produced a malformed Info.plist"
grep -q "$BUNDLE_ID" "$CONTENTS/Info.plist" || die "Info.plist does not declare $BUNDLE_ID"
/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$CONTENTS/Info.plist" | grep -qi true \
  || die "Info.plist does not set LSUIElement — the app would take a Dock icon"

mkdir -p "$RES/bin" "$RES/privileged"

# --- app icon ---------------------------------------------------------------
# Committed rather than rendered here: CI must not need Chrome to build the .app.
# Re-render with `bun run --cwd packages/assets render:icon` and copy out/icon/AppIcon.icns.
step "Icon"
ICON_SRC="$ROOT/apps/tray/Resources/AppIcon.icns"
[ -f "$ICON_SRC" ] || die "apps/tray/Resources/AppIcon.icns is missing — run packages/assets' render:icon"
ICON_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$CONTENTS/Info.plist" 2>/dev/null)" \
  || die "Info.plist does not declare CFBundleIconFile — the app would ship with no icon"
# CFBundleIconFile may or may not carry the extension; both are legal.
ICON_DEST="$RES/${ICON_NAME%.icns}.icns"
cp "$ICON_SRC" "$ICON_DEST"
info "$(basename "$ICON_DEST") ($(du -h "$ICON_DEST" | cut -f1))"

# --- compiled Bun binaries --------------------------------------------------
step "Compiling forwarder and mcp"
[ -f "$ROOT/packages/forwarder/src/index.ts" ] || die "packages/forwarder/src/index.ts is missing"
[ -f "$ROOT/packages/mcp/src/index.ts" ]       || die "packages/mcp/src/index.ts is missing"
( cd "$ROOT" && bun build --compile --minify --sourcemap packages/forwarder/src/index.ts --outfile "$RES/forwarder" >/dev/null )
( cd "$ROOT" && bun build --compile --minify --sourcemap packages/mcp/src/index.ts       --outfile "$RES/mcp"       >/dev/null )
chmod +x "$RES/forwarder" "$RES/mcp"
info "forwarder $(du -h "$RES/forwarder" | cut -f1), mcp $(du -h "$RES/mcp" | cut -f1)"

# --- privileged entrypoint --------------------------------------------------
step "Privileged scripts"
PRIV_SRC="$ROOT/packages/privileged"
[ -f "$PRIV_SRC/apply.sh" ] || die "packages/privileged/apply.sh is missing"
# The whole directory, not just apply.sh: both entrypoints source lib.sh from beside
# themselves and abort if it is missing.
find "$PRIV_SRC" -maxdepth 1 -type f -name '*.sh' -exec cp {} "$RES/privileged/" \;
chmod +x "$RES"/privileged/*.sh
# teardown.sh and self-delete.sh are what make an uninstall possible with no checkout on the
# machine — the whole point of shipping them. A bundle without them can tear down the system
# changes but can never remove itself.
for required in apply.sh lib.sh uninstall.sh teardown.sh self-delete.sh; do
  [ -f "$RES/privileged/$required" ] || die "packages/privileged/$required is missing"
done
info "$(ls "$RES/privileged" | tr '\n' ' ')"

# --- embedded Bun -----------------------------------------------------------
step "Embedding Bun"
BUN_BIN="$(command -v bun)" || die "bun is not on PATH"
# command -v can hand back a shim; follow it to the real Mach-O.
BUN_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$BUN_BIN")"
is_macho "$BUN_BIN" || die "$BUN_BIN is not a Mach-O executable"
cp "$BUN_BIN" "$RES/bin/bun"
chmod +x "$RES/bin/bun"
info "$BUN_BIN ($("$RES/bin/bun" --version))"

# --- dashboard --------------------------------------------------------------
# `next build` with output:"standalone" writes a self-contained server tree, but it
# deliberately OMITS .next/static and public: Next assumes a CDN serves them. Copying
# them in is not optional — without .next/static the page renders with no CSS at all.
step "Building the dashboard"
# From scratch: a partial .next from an interrupted or dev build leaves stale .nft.json
# trace files and `next build` dies on them mid-way through the standalone step.
rm -rf "$ROOT/packages/dashboard/.next" 2>/dev/null || true
( cd "$ROOT/packages/dashboard" && bun run build >/dev/null )
STANDALONE="$ROOT/packages/dashboard/.next/standalone"
[ -d "$STANDALONE" ] || die "no .next/standalone — packages/dashboard/next.config must set output: 'standalone'"

rm -rf "$RES/dashboard"
mkdir -p "$RES/dashboard"
cp -R "$STANDALONE"/. "$RES/dashboard"/

# In a workspace the standalone tree mirrors the monorepo, so server.js lands under
# packages/dashboard/. Find it rather than assuming either layout.
SERVER_JS="$(find "$RES/dashboard" -maxdepth 4 -name server.js -not -path '*/node_modules/*' | head -n1)"
[ -n "$SERVER_JS" ] || die "no server.js in the standalone output"
SERVER_DIR="$(dirname "$SERVER_JS")"

mkdir -p "$SERVER_DIR/.next"
cp -R "$ROOT/packages/dashboard/.next/static" "$SERVER_DIR/.next/static"
if [ -d "$ROOT/packages/dashboard/public" ]; then
  cp -R "$ROOT/packages/dashboard/public" "$SERVER_DIR/public"
fi

# runtimeLayout() points every consumer at Resources/dashboard, so keep server.js there
# whatever Next decided to do with the directory nesting.
if [ "$SERVER_DIR" != "$RES/dashboard" ]; then
  REL="${SERVER_DIR#"$RES/dashboard/"}"
  cat > "$RES/dashboard/server.js" <<JS
// The standalone output nests the real server; this keeps Resources/dashboard/server.js
// the single entrypoint regardless of the monorepo layout Next mirrored.
require("./$REL/server.js");
JS
  info "server.js shim -> $REL/server.js"
fi
info "dashboard $(du -sh "$RES/dashboard" | cut -f1), static $(du -sh "$SERVER_DIR/.next/static" | cut -f1)"

# --- verify the assembled tree actually serves a styled page ----------------
step "Verifying the bundled dashboard"
verify_dashboard "$RES"

# --- done -------------------------------------------------------------------
touch "$APP"
step "Done: $APP ($(du -sh "$APP" | cut -f1))"
