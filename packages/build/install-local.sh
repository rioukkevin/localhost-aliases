#!/usr/bin/env bash
#
# Copy the built app into /Applications, or ~/Applications when /Applications is not
# writable. Never sudo: an app the user cannot delete without a password is worse than
# an app in their home folder.
#
# Env: LA_INSTALL_DIR (install somewhere else entirely — used by tests).

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ -d "$APP" ] || die "$APP does not exist — run 'make bundle' first"

# --- destination ------------------------------------------------------------
if [ -n "${LA_INSTALL_DIR:-}" ]; then
  DEST_DIR="$LA_INSTALL_DIR"
  mkdir -p "$DEST_DIR"
elif [ -w /Applications ]; then
  DEST_DIR=/Applications
else
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
  info "/Applications is not writable, using $DEST_DIR (no password needed)"
fi
DEST="$DEST_DIR/$APP_NAME.app"

# --- refuse to overwrite a running app --------------------------------------
# Replacing the bundle under a running process corrupts it: the app keeps mapping files
# that no longer exist and dies in confusing ways. Ask the user to quit it instead —
# never kill it, and never by pattern.
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  die "$APP_NAME is running (pid $(pgrep -x "$APP_NAME" | tr '\n' ' ')). Quit it from the menu bar, then run 'make install' again."
fi
if [ -e "$DEST" ] && lsof "$DEST/Contents/MacOS/$APP_NAME" >/dev/null 2>&1; then
  die "$DEST is in use. Quit $APP_NAME from the menu bar, then run 'make install' again."
fi

# --- install ----------------------------------------------------------------
step "Installing to $DEST"
if [ -e "$DEST" ]; then
  rm -rf "$DEST" || die "could not remove $DEST — is it owned by another user?"
  info "replaced the previous install"
fi
# ditto keeps the signature intact; cp -R drops extended attributes and breaks it.
ditto "$APP" "$DEST" || die "could not copy into $DEST_DIR"

# A stale quarantine flag makes macOS re-prompt about an app the user just built.
xattr -d -r com.apple.quarantine "$DEST" 2>/dev/null || true

step "Installed"
info "$DEST ($(du -sh "$DEST" | cut -f1))"
info "Open it from Spotlight or: open \"$DEST\""
info "It has no Dock icon by design — look for it in the menu bar."
