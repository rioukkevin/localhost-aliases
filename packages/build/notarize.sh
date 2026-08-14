#!/usr/bin/env bash
#
# Notarize the signed app and staple the ticket to it.
#
# This script needs Apple credentials and will refuse to run without them. There are no
# stored credentials in this repo and none are created for you — see the message below
# for the exact command to run once, yourself.
#
# NOTARY_ARGS carries the credentials, e.g. either of:
#   NOTARY_ARGS="--keychain-profile localhost-aliases"
#   NOTARY_ARGS="--key /path/AuthKey_ABC123.p8 --key-id ABC123 --issuer <uuid>"
# The release workflow builds the second form from repository secrets.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

credentials_help() {
  cat >&2 <<MSG

Notarization needs App Store Connect credentials. Store them once, in your keychain:

    xcrun notarytool store-credentials "localhost-aliases" \\
      --key /path/to/AuthKey_XXXXXXXXXX.p8 \\
      --key-id XXXXXXXXXX \\
      --issuer 00000000-0000-0000-0000-000000000000

  Create the key at https://appstoreconnect.apple.com/access/integrations/api
  (Developer role or higher). Download the .p8 once — Apple will not show it again.

Then:

    NOTARY_ARGS="--keychain-profile localhost-aliases" make notarize

An Apple ID and app-specific password also work, but the API key is scoped and revocable:

    NOTARY_ARGS="--apple-id you@example.com --team-id $TEAM_ID --password <app-specific-password>"
MSG
}

[ -d "$APP" ] || die "$APP does not exist — run 'make bundle' and 'make sign' first"

if [ -z "${NOTARY_ARGS:-}" ]; then
  printf '\033[31merror:\033[0m NOTARY_ARGS is not set, so there is nothing to authenticate with.\n' >&2
  credentials_help
  exit 1
fi

# Apple rejects an unsigned or ad-hoc submission after the upload, which wastes minutes.
step "Checking the signature before uploading"
codesign --verify --deep --strict "$APP" || die "$APP is not validly signed — run 'make sign' first"
DESC="$(codesign -dv "$APP" 2>&1)"
printf '%s' "$DESC" | grep -q 'flags=.*runtime' || die "$APP is not signed with --options runtime; Apple will reject it"
if printf '%s' "$DESC" | grep -q 'TeamIdentifier=not set'; then
  die "$APP is ad-hoc signed; notarization needs a real Developer ID identity"
fi
info "signed, hardened runtime on"

VERSION="$(app_version)"
ZIP="$DIST/$APP_NAME-$VERSION-notarize.zip"

step "Zipping for submission"
rm -f "$ZIP"
# ditto -c -k --keepParent is the only archiver Apple documents for this; zip(1) mangles
# symlinks and extended attributes and the submission fails validation.
ditto -c -k --keepParent "$APP" "$ZIP"
info "$(du -h "$ZIP" | cut -f1)"

step "Submitting to Apple (this waits for the verdict)"
set +e
# shellcheck disable=SC2086 -- NOTARY_ARGS is deliberately word-split.
SUBMIT_OUTPUT="$(xcrun notarytool submit "$ZIP" --wait --timeout 30m $NOTARY_ARGS 2>&1)"
SUBMIT_STATUS=$?
set -e
printf '%s\n' "$SUBMIT_OUTPUT" | sed 's/^/    /'

if [ $SUBMIT_STATUS -ne 0 ] || ! printf '%s' "$SUBMIT_OUTPUT" | grep -q 'status: Accepted'; then
  SUBMISSION_ID="$(printf '%s' "$SUBMIT_OUTPUT" | awk '/^ *id: /{print $2; exit}')"
  if [ -n "$SUBMISSION_ID" ]; then
    step "Notarization log for $SUBMISSION_ID"
    # shellcheck disable=SC2086
    xcrun notarytool log "$SUBMISSION_ID" $NOTARY_ARGS 2>&1 | sed 's/^/    /' || true
  fi
  rm -f "$ZIP"
  die "notarization did not come back Accepted"
fi
rm -f "$ZIP"

# The ticket is stapled to the .app so the app also passes Gatekeeper offline.
step "Stapling the ticket"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

step "Gatekeeper, as a user's Mac will see it"
spctl -a -vvv -t exec "$APP"

step "Notarized and stapled: $APP"
