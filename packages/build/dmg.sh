#!/usr/bin/env bash
#
# Package the built app into a DMG with the usual drag-to-/Applications layout, then
# mount it and check what a user would actually see.
#
# Runs on a signed or unsigned app: CI builds the DMG last, whether or not the signing
# secrets were present.
#
# Env: DIST, SIGN_IDENTITY (sign the DMG too, when set).

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ -d "$APP" ] || die "$APP does not exist — run 'make bundle' first"

VERSION="$(app_version)"
VOLNAME="Localhost Aliases"
DMG="$DIST/$APP_NAME-$VERSION.dmg"
STAGE="$DIST/.dmg-staging"
MOUNT="$DIST/.dmg-mount"

step "Staging"
rm -rf "$STAGE" "$MOUNT" "$DMG"
mkdir -p "$STAGE"
# ditto, not cp: it preserves the extended attributes and symlinks a signature seals.
ditto "$APP" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
info "$APP_NAME.app + /Applications symlink"

step "Building $(basename "$DMG")"
hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$DMG" >/dev/null
rm -rf "$STAGE"
info "$(du -h "$DMG" | cut -f1)"

# The app inside is already signed and stapled by this point; the disk image is a separate
# artifact and needs its own signature, or the file the user downloads is unsigned even though
# everything in it is not. `make sign` finds the identity the same way, and CI runs `make dmg`
# without exporting anything, so fall back to the same lookup rather than silently skipping.
if [ -z "${SIGN_IDENTITY:-}" ]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep 'Developer ID Application' | grep "$TEAM_ID" \
    | head -n1 | sed -E 's/.*"(.*)".*/\1/' || true)"
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  step "Signing the DMG"
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
  info "signed with $SIGN_IDENTITY"
else
  # Not fatal: an unsigned local or fork build is a legitimate outcome, and the release notes
  # and the site both say plainly that nothing has been signed.
  info "no Developer ID Application identity for team $TEAM_ID — the DMG is unsigned"
fi

# --- verify by mounting it, the way a user opens it -------------------------
step "Mounting to verify"
mkdir -p "$MOUNT"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null
# Detach whatever happens next, so a failed check never leaves a volume mounted.
trap 'hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true' EXIT

[ -d "$MOUNT/$APP_NAME.app" ] || die "the DMG has no $APP_NAME.app"
[ -L "$MOUNT/Applications" ] || die "the DMG has no /Applications symlink"
[ -x "$MOUNT/$APP_NAME.app/Contents/MacOS/$APP_NAME" ] || die "the app in the DMG has no executable"
for required in Resources/bin/bun Resources/forwarder Resources/mcp \
                Resources/privileged/apply.sh Resources/dashboard/server.js; do
  [ -e "$MOUNT/$APP_NAME.app/Contents/$required" ] || die "the app in the DMG is missing Contents/$required"
done
info "$(ls "$MOUNT" | tr '\n' ' ')"
info "app $(du -sh "$MOUNT/$APP_NAME.app" | cut -f1), $(ls "$MOUNT/$APP_NAME.app/Contents/Resources" | tr '\n' ' ')"

hdiutil detach "$MOUNT" -quiet
rmdir "$MOUNT" 2>/dev/null || true
trap - EXIT
info "unmounted cleanly"

step "Done: $DMG"
