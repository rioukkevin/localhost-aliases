#!/usr/bin/env bash
#
# plists.sh — the two property lists the bundle carries, and PkgInfo.
#
#   scripts/package/plists.sh
#
# 1. Contents/Info.plist — copied verbatim from apps/tray/Info.plist (the tray owns it:
#    LSUIElement, the bundle id, the version). Only linted here.
# 2. Contents/Library/LaunchDaemons/dev.localhost-aliases.helper.plist — generated here.
#
# `SMAppService.daemon(plistName:)` requires *both* halves: this plist at exactly this
# path, and the executable it names inside Contents/MacOS. `BundleProgram` is resolved
# relative to the .app, which is the whole point — the daemon moves with the app, and
# nothing ever writes to /Library/LaunchDaemons.
#
# Every plist is `plutil -lint`ed. An invalid one is only discovered by launchd, at
# registration time, as an error the user cannot act on.

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

TRAY_INFO_PLIST="$REPO_ROOT/apps/tray/Info.plist"
[ -f "$TRAY_INFO_PLIST" ] || die "missing $TRAY_INFO_PLIST"

step "Info.plist"
mkdir -p "$CONTENTS"
cp "$TRAY_INFO_PLIST" "$CONTENTS/Info.plist"
lint_plist "$CONTENTS/Info.plist"
# The bundle id is what AssociatedBundleIdentifiers below points back at; a mismatch means
# the daemon shows up in System Settings as an anonymous entry the user cannot identify.
ACTUAL_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CONTENTS/Info.plist")"
[ "$ACTUAL_ID" = "$BUNDLE_ID" ] || die "Info.plist declares $ACTUAL_ID, expected $BUNDLE_ID"
ok "CFBundleIdentifier $ACTUAL_ID"

printf 'APPL????' >"$CONTENTS/PkgInfo"
ok "PkgInfo"

step "LaunchDaemon plist"
mkdir -p "$LAUNCHDAEMONS_DIR"
cat >"$HELPER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$HELPER_LABEL</string>
  <!-- Relative to the .app bundle, not to /. This is what makes the daemon relocatable
       and is required by SMAppService. -->
  <key>BundleProgram</key>
  <string>Contents/MacOS/la-helper</string>
  <!-- Names the app in System Settings > Login Items, so the user knows what they are
       looking at and can turn it off. -->
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>$BUNDLE_ID</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- It proxies interactive HTTP traffic; the default background QoS adds latency to
       every request the user makes to their own dev server. -->
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- A launchd daemon inherits almost nothing. The helper shells out to exactly two
         fixed commands (dscacheutil, killall) and both live here. -->
    <key>PATH</key>
    <string>/usr/sbin:/usr/bin:/sbin:/bin</string>
  </dict>
  <!-- Plain files in /var/log, not a directory: nothing creates directories for a daemon
       registered by SMAppService, and launchd silently drops output it cannot open. -->
  <key>StandardOutPath</key>
  <string>/var/log/localhost-aliases.helper.out.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/localhost-aliases.helper.err.log</string>
</dict>
</plist>
PLIST

lint_plist "$HELPER_PLIST"
PROGRAM="$(/usr/libexec/PlistBuddy -c 'Print :BundleProgram' "$HELPER_PLIST")"
[ "$PROGRAM" = "Contents/MacOS/la-helper" ] || die "BundleProgram is '$PROGRAM'"
ok "BundleProgram -> $PROGRAM"
ok "$(basename "$HELPER_PLIST")"
