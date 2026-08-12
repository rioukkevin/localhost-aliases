#!/usr/bin/env bash
#
# sign.sh — Developer ID + hardened runtime, applied inside-out.
#
# Code signing a bundle is not one operation, it is N+1: every nested Mach-O carries its
# own signature and its own entitlements, and the outer signature seals a *hash* of each
# of them. Sign the outer bundle first and every nested signature invalidates it, so this
# script walks the bundle deepest-path-first and signs the .app last. (`codesign --deep`
# looks like a shortcut and is not: Apple documents it as a verification aid, it applies
# the same entitlements to every binary it touches, and it silently skips things.)
#
#   ./scripts/package/sign.sh                      # sign dist/LocalhostAliases.app
#   ./scripts/package/sign.sh --app path/to.app
#   ./scripts/package/sign.sh --verify-only        # re-run the checks, sign nothing
#   ./scripts/package/sign.sh --entitlements X     # try a different entitlement set
#
# Signing is local and reversible: re-run it to replace a signature.

set -euo pipefail

LA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$LA_SCRIPT_DIR/../.." && pwd -P)"
# shellcheck source=../lib.sh
. "$REPO_ROOT/scripts/lib.sh"

APP="${LA_APP:-}"
IDENTITY="${LA_SIGN_IDENTITY:-}"
ENTITLEMENTS="$LA_SCRIPT_DIR/entitlements/bun.plist"
VERIFY_ONLY=0

usage() {
  cat <<'USAGE'
usage: ./scripts/package/sign.sh [options]

Options:
  --app PATH            The .app to sign. Default: dist/LocalhostAliases.app, then
                        apps/tray/LocalhostAliases.app.
  --identity NAME       Signing identity. Default: the single "Developer ID Application"
                        identity in the login keychain (required when there is more than one).
  --entitlements PATH   Entitlements for the Bun binaries. Default: entitlements/bun.plist.
  --verify-only         Run the verification block against an already-signed bundle.
  -h, --help            This text.

Environment: LA_APP, LA_SIGN_IDENTITY — same as --app / --identity.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) [ $# -ge 2 ] || la_die "--app needs a path"; APP="$2"; shift 2 ;;
    --app=*) APP="${1#--app=}"; shift ;;
    --identity) [ $# -ge 2 ] || la_die "--identity needs a name"; IDENTITY="$2"; shift 2 ;;
    --identity=*) IDENTITY="${1#--identity=}"; shift ;;
    --entitlements) [ $# -ge 2 ] || la_die "--entitlements needs a path"; ENTITLEMENTS="$2"; shift 2 ;;
    --entitlements=*) ENTITLEMENTS="${1#--entitlements=}"; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; la_die "unknown option: $1" ;;
  esac
done

la_require_macos

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
if [ -z "$APP" ]; then
  for candidate in "$REPO_ROOT/dist/LocalhostAliases.app" "$REPO_ROOT/apps/tray/LocalhostAliases.app"; do
    if [ -d "$candidate" ]; then APP="$candidate"; break; fi
  done
fi
[ -n "$APP" ] || la_die "no .app found.
  Build the bundle first (see docs/RELEASE.md), or pass --app <path>."
[ -d "$APP" ] || la_die "not a directory: $APP"
APP="$(cd -- "$APP" && pwd -P)"

MAIN_EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$MAIN_EXE_NAME" ] || la_die "$APP/Contents/Info.plist has no CFBundleExecutable — this is not an app bundle."
MAIN_EXE="$APP/Contents/MacOS/$MAIN_EXE_NAME"
[ -x "$MAIN_EXE" ] || la_die "main executable missing: $MAIN_EXE"

[ -f "$ENTITLEMENTS" ] || la_die "entitlements file not found: $ENTITLEMENTS"
/usr/bin/plutil -lint "$ENTITLEMENTS" >/dev/null || la_die "$ENTITLEMENTS is not a valid plist"

# Discover the identity rather than hardcoding it: certificates expire and get replaced,
# and a stale SHA-1 in a script is a release-day outage.
if [ -z "$IDENTITY" ]; then
  found="$("$LA_SECURITY" find-identity -v -p codesigning 2>/dev/null \
            | /usr/bin/sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p')"
  count="$(printf '%s' "$found" | /usr/bin/grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    la_die "no \"Developer ID Application\" identity in your keychains.

  A Developer ID certificate is what lets a build run on someone else's Mac. To get one:
    1. https://developer.apple.com/account/resources/certificates  ->  +
    2. choose 'Developer ID Application', upload a CSR
       (Keychain Access -> Certificate Assistant -> Request a Certificate From a
        Certificate Authority -> 'Saved to disk')
    3. download the .cer and double-click it to import into the login keychain
    4. confirm with: security find-identity -v -p codesigning

  An 'Apple Development' certificate is NOT a substitute: it only runs on registered
  devices and cannot be notarised."
  elif [ "$count" -gt 1 ]; then
    la_die "more than one Developer ID Application identity — pick one with --identity:
$(printf '%s' "$found" | /usr/bin/sed 's/^/    /')"
  fi
  IDENTITY="$found"
fi

la_step "Signing $APP"
la_info "identity:     $IDENTITY"
la_info "entitlements: ${ENTITLEMENTS#"$REPO_ROOT/"} ($(/usr/bin/plutil -convert json -o - "$ENTITLEMENTS" | /usr/bin/tr -d '\n'))"

# ---------------------------------------------------------------------------
# Which nested files are actually code?
# ---------------------------------------------------------------------------
# Deciding what is code is the fiddly part, and two obvious answers are both wrong:
#   - `file` reports "Mach-O 64-bit bundle arm64" for caniuse-lite's *JavaScript* data
#     files, whose first bytes happen to match its heuristic;
#   - `otool -h` prints "is not an object file" and still exits 0.
# Either would hand codesign a text file. `lipo -info` actually parses the header and
# exits non-zero when there isn't one, so it is the arbiter. The find(1) filter only keeps
# the number of lipo invocations to a handful instead of ~2000 — it cannot be the test on
# its own, because npm ships plenty of 0755 package.json files.
nested_machos() {
  local candidate
  find "$APP" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' -o -name '*.node' \) -print \
    | while IFS= read -r candidate; do
        [ "$candidate" = "$MAIN_EXE" ] && continue
        if /usr/bin/lipo -info "$candidate" >/dev/null 2>&1; then
          # depth-prefixed so the caller can sign the deepest paths first
          printf '%s\t%s\n' "$(printf '%s' "$candidate" | /usr/bin/tr -cd '/' | /usr/bin/wc -c | /usr/bin/tr -d ' ')" "$candidate"
        fi
      done \
    | /usr/bin/sort -rn -k1,1 | /usr/bin/cut -f2-
}

# The two Bun-based binaries are the only ones that need entitlements. Everything else
# nested (a .node addon, a dylib) gets a plain hardened signature.
needs_jit() {
  case "${1#"$APP/"}" in
    Contents/Resources/bin/bun|Contents/MacOS/la-helper) return 0 ;;
    *) return 1 ;;
  esac
}

sign_one() {
  local target="$1"; shift
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$@" "$target" 2>&1 \
    | /usr/bin/sed "s|$APP|<app>|g; s/^/        /"
  return "${PIPESTATUS[0]}"
}

if [ "$VERIFY_ONLY" = "0" ]; then
  # Quarantine flags and other xattrs make codesign fail with an unhelpful "resource fork,
  # Finder information, or similar detritus not allowed" — clear them once, up front.
  la_run xattr -cr "$APP"

  la_step "Nested binaries (deepest first)"
  while IFS= read -r binary; do
    [ -n "$binary" ] || continue
    if needs_jit "$binary"; then
      la_info "${binary#"$APP/"}  [+ JIT entitlement]"
      sign_one "$binary" --entitlements "$ENTITLEMENTS" || la_die "failed to sign $binary"
    else
      la_info "${binary#"$APP/"}"
      sign_one "$binary" || la_die "failed to sign $binary"
    fi
  done < <(nested_machos)

  # The tray itself is AppKit Swift: it never JITs and never loads third-party code, so the
  # outer signature carries no entitlements at all. Its children each carry their own.
  la_step "Outer bundle"
  la_info "${APP#"$REPO_ROOT/"}"
  sign_one "$APP" || la_die "failed to sign $APP"
fi

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
la_step "codesign --verify --deep --strict --verbose=2"
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | /usr/bin/sed 's/^/    /'; then
  la_ok "bundle signature valid, and every nested signature it seals is valid"
else
  la_die "signature verification failed"
fi

la_step "Entitlements, per nested binary"
while IFS= read -r binary; do
  [ -n "$binary" ] || continue
  printf '    %s\n' "${binary#"$APP/"}"
  codesign -dv --entitlements - "$binary" 2>&1 | /usr/bin/sed 's/^/        /'
done < <(nested_machos)
printf '    %s\n' "${MAIN_EXE#"$APP/"}"
codesign -dv --entitlements - "$MAIN_EXE" 2>&1 | /usr/bin/sed 's/^/        /'

# Gatekeeper's answer, and it is expected to be "rejected" until the build is notarised:
# a Developer ID signature proves *who* built it, notarisation proves Apple scanned it.
# Non-fatal on purpose — this is the last thing that turns green, after notarize.sh.
la_step "spctl -a -vvv -t install (Gatekeeper assessment)"
if spctl -a -vvv -t install "$APP" 2>&1 | /usr/bin/sed 's/^/    /'; then
  la_ok "Gatekeeper accepts this build — it carries a notarisation ticket"
else
  la_warn "rejected by Gatekeeper. Expected before notarisation: 'source=Unnotarized Developer ID'
      means the signature is a valid Developer ID one but Apple has not seen the build yet.
      Run scripts/package/notarize.sh (needs credentials — see docs/RELEASE.md) and re-check.
      Any other rejection reason is a real problem."
fi

la_step "Done"
la_say "  Next: scripts/package/dmg.sh, then scripts/package/notarize.sh."
