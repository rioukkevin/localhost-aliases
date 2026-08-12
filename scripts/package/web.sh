#!/usr/bin/env bash
#
# web.sh — build the dashboard and assemble Contents/Resources/web.
#
#   scripts/package/web.sh [--out DIR] [--no-build]
#
# `output: "standalone"` gives us a tree that runs with no node_modules install and no
# checkout, but Next lays it out relative to the *workspace* root:
#
#   .next/standalone/node_modules/            traced dependencies
#   .next/standalone/packages/web/server.js   the entry
#   .next/standalone/packages/web/.next/      server chunks + manifests
#
# The bundle needs `Resources/web/server.js` (that is what the tray launches), so the two
# halves are flattened back together here: server.js at the root, node_modules beside it.
# server.js resolves everything from its own directory, so the flattened tree is exactly
# what it expects.
#
# And the part that is easy to miss: **standalone deliberately omits `.next/static`**.
# Nothing errors without it — the HTML still renders, the stylesheet 404s, and the app
# silently loses every pixel of its design. So it is copied explicitly and then asserted.

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

OUT="$WEB_DIR"
BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

need ditto
BUN="$(find_bun)"
WEB_SRC="$REPO_ROOT/packages/web"

if [ "$BUILD" -eq 1 ]; then
  step "Building the dashboard (next build, output: standalone)"
  # Through the package script, and with LA_NEXT_DIST_DIR cleared: the bundle must be
  # assembled from the production .next tree, never from some test's build directory.
  ( cd "$REPO_ROOT" && env -u LA_NEXT_DIST_DIR "$BUN" run --cwd packages/web build ) \
    || die "next build failed"
  ok "built"
else
  info "reusing the existing build"
fi

STANDALONE="$WEB_SRC/.next/standalone"
STATIC="$WEB_SRC/.next/static"
[ -f "$STANDALONE/packages/web/server.js" ] \
  || die "no standalone output at $STANDALONE — is output:\"standalone\" still set in next.config.ts?"
[ -d "$STATIC" ] || die "no $STATIC — the build did not finish"

step "Assembling $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# 1. the entry, its manifests and its server chunks
ditto "$STANDALONE/packages/web" "$OUT"
# 2. the traced dependencies, moved from the workspace root down beside server.js
ditto "$STANDALONE/node_modules" "$OUT/node_modules"
# 3. the client assets standalone leaves behind — CSS, JS chunks, fonts
ditto "$STATIC" "$OUT/.next/static"
# 4. public/ is optional in this app, but shipping it when it exists costs nothing
if [ -d "$WEB_SRC/public" ]; then
  ditto "$WEB_SRC/public" "$OUT/public"
  ok "public/ copied"
fi

step "Checking the assembled tree"
[ -f "$OUT/server.js" ]        || die "missing $OUT/server.js"
[ -f "$OUT/.next/BUILD_ID" ]   || die "missing $OUT/.next/BUILD_ID"
[ -d "$OUT/node_modules/next" ] || die "missing $OUT/node_modules/next"
CSS_COUNT="$(find "$OUT/.next/static" -name '*.css' | wc -l | tr -d ' ')"
[ "$CSS_COUNT" -gt 0 ] || die "no stylesheet under $OUT/.next/static — the UI would render unstyled"
ok "server.js, .next/BUILD_ID, node_modules/next, $CSS_COUNT stylesheet(s)"
ok "$(human_size "$OUT")"
