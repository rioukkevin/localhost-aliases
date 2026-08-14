#!/usr/bin/env bash
#
# Remove the app and every change it made to this Mac.
#
# The root-only work — stopping the forwarder, removing the lo0 aliases, stripping the
# managed block from /etc/hosts, flushing DNS — is done by packages/privileged/uninstall.sh
# behind ONE admin prompt raised here. Everything else is the user's own files and needs
# no password.
#
# This script never runs sudo and never edits a system file itself.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# --- locate what is installed -----------------------------------------------
INSTALLED=""
for candidate in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app" "$APP"; do
  [ -d "$candidate" ] && { INSTALLED="$candidate"; break; }
done

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  die "$APP_NAME is running. Quit it from the menu bar first, then run 'make uninstall'."
fi

# Prefer the scripts inside the installed bundle: they are the ones that were used.
PRIV_DIR=""
for candidate in "${INSTALLED:+$INSTALLED/Contents/Resources/privileged}" "$ROOT/packages/privileged"; do
  [ -n "$candidate" ] && [ -f "$candidate/uninstall.sh" ] && { PRIV_DIR="$candidate"; break; }
done
[ -n "$PRIV_DIR" ] || die "no privileged/uninstall.sh found — cannot revert the system changes safely"

FORWARDER=""
[ -n "$INSTALLED" ] && [ -x "$INSTALLED/Contents/Resources/forwarder" ] && FORWARDER="$INSTALLED/Contents/Resources/forwarder"

# The one place that knows where user state lives is core; do not second-guess it.
CONFIG_DIR="$(bun -e 'const { configDir } = await import("@localhost-aliases/core/paths"); console.log(configDir())' 2>/dev/null || echo "$HOME/.config/localhost-aliases")"

# --- one admin prompt --------------------------------------------------------
shquote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
asquote() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

CMD="/usr/bin/env LA_CONFIG_DIR=$(shquote "$CONFIG_DIR")"
[ -n "$FORWARDER" ] && CMD="$CMD LA_FORWARDER=$(shquote "$FORWARDER")"
CMD="$CMD /bin/bash $(shquote "$PRIV_DIR/uninstall.sh")"

step "Reverting system changes"
info "$PRIV_DIR/uninstall.sh"
info "macOS will ask for your password once."
OUTPUT="$(osascript -e "do shell script \"$(asquote "$CMD")\" with administrator privileges" 2>&1)" || {
  printf '%s\n' "$OUTPUT" | sed 's/^/    /'
  die "the privileged uninstall failed; nothing was deleted, so you can fix it and retry"
}
printf '%s\n' "$OUTPUT" | sed 's/^/    /'

# --- the user's own files (no password needed) -------------------------------
# The local CA is trusted in the login keychain, which is the user's, not root's.
CA_CERT="$CONFIG_DIR/ca/rootCA.pem"
if [ -f "$CA_CERT" ]; then
  step "Removing the local CA from the login keychain"
  # Match by fingerprint, never by name: deleting the wrong certificate is unrecoverable.
  SHA1="$(openssl x509 -in "$CA_CERT" -noout -fingerprint -sha1 2>/dev/null | cut -d= -f2 | tr -d ':')"
  if [ -n "$SHA1" ]; then
    security delete-certificate -Z "$SHA1" -t "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null \
      && info "removed $SHA1" \
      || info "not in the login keychain (already gone)"
  fi
fi

if [ -d "$CONFIG_DIR" ]; then
  step "Removing $CONFIG_DIR"
  rm -rf "$CONFIG_DIR"
fi

if [ -n "$INSTALLED" ]; then
  step "Removing $INSTALLED"
  rm -rf "$INSTALLED" || die "could not remove $INSTALLED"
else
  info "no installed $APP_NAME.app found"
fi

rm -rf "$DIST"

step "Uninstalled"
info "Your projects are untouched, and /etc/hosts keeps every line outside the managed block."
