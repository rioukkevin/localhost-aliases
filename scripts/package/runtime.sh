#!/usr/bin/env bash
#
# runtime.sh — embed the Bun runtime at Contents/Resources/bin/bun.
#
#   scripts/package/runtime.sh [--out PATH]
#
# The dashboard is TypeScript-adjacent JavaScript that calls Bun-native APIs (`Bun.file`,
# `Bun.serve`, `fetch(url, { unix })`), so the .app cannot rely on whatever bun the user
# may or may not have installed — a Finder-launched app barely has a PATH at all. The exact
# interpreter that was tested ships inside the bundle.
#
# It is copied, not linked: `cp` dereferences, so a Homebrew symlink still yields the real
# Mach-O. Signing treats it as a nested binary of its own (docs/PHASE4.md §6).

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

OUT="$BUN_EXECUTABLE"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

BUN="$(find_bun)"
VERSION="$("$BUN" --version)"
REVISION="$("$BUN" --revision 2>/dev/null || printf '%s' "$VERSION")"

step "Embedding the Bun runtime"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
cp "$BUN" "$OUT"
chmod 0755 "$OUT"

# The embedded copy must be the same architecture as the compiled helper and the tray.
case "$(file -b "$OUT")" in
  *"$(uname -m)"*) ;;
  *) die "embedded bun is not $(uname -m): $(file -b "$OUT")" ;;
esac

# Provenance for the signing and notarisation steps, and for bug reports. Kept beside the
# bundle rather than inside it: Contents/ is a frozen layout.
mkdir -p "$BUILD_DIR"
printf 'bun %s (%s)\nsource: %s\n' "$VERSION" "$REVISION" "$BUN" >"$BUILD_DIR/bun-version.txt"

ok "$OUT ($(human_size "$OUT"))"
ok "bun $VERSION ($REVISION) from $BUN"

# Prove the copy is not merely present but runnable from its new home.
EMBEDDED="$("$OUT" --version)"
[ "$EMBEDDED" = "$VERSION" ] || die "the embedded bun reports $EMBEDDED, expected $VERSION"
ok "the embedded binary runs ($EMBEDDED)"
