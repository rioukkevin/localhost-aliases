#!/bin/bash
#
# Remove the .app, from outside the .app.
#
#   self-delete.sh <bundle> [pid-to-outlive]
#
# A running application cannot reliably delete its own bundle: the kernel still has the
# executable and its resources mapped, and the process is executing a file that is being
# unlinked underneath it. So teardown.sh copies THIS script into a scratch directory outside
# the bundle, spawns it detached, and quits. This script then waits for that pid to be gone
# and removes the bundle.
#
# It refuses to delete anything that is not our bundle. The path is not trusted just because
# it was passed in: it must be absolute, must be named LocalhostAliases.app, must contain our
# executable, and its Info.plist must declare our bundle id. /Applications and ~/Applications
# are the two real installs; a developer's dist/ copy satisfies the same checks.
#
# It never lingers. The wait is bounded, the removal is attempted once, and the script exits
# either way — a helper that sat forever on a pid that never dies would be a worse leftover
# than the bundle it was sent to remove.
#
# Environment:
#   LA_SELF_DELETE_LOG       where progress goes. Default $TMPDIR/localhost-aliases-uninstall.log
#   LA_SELF_DELETE_SCRATCH   this script's own scratch copy, removed on the way out
#   LA_SELF_DELETE_TIMEOUT   seconds to wait for the pid. Default 60.
#   LA_BUNDLE_EXECUTABLE / LA_BUNDLE_ID   the identity checks, overridable for tests only.

set -uo pipefail

LOG="${LA_SELF_DELETE_LOG:-${TMPDIR:-/tmp}/localhost-aliases-uninstall.log}"
LOG="${LOG//\/\///}"
TIMEOUT="${LA_SELF_DELETE_TIMEOUT:-60}"
EXECUTABLE_NAME="${LA_BUNDLE_EXECUTABLE:-LocalhostAliases}"
BUNDLE_ID="${LA_BUNDLE_ID:-dev.localhost-aliases.app}"

# The log file only. When this runs detached its stdout IS the log file, and printing to
# both put every line in twice.
log() {
  printf '%s self-delete: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG" 2>/dev/null || true
}

finish() { # <status> <detail…>
  local status="$1"; shift
  log "$status: $*"
  printf 'LA_SELF_DELETE status=%s detail=%s\n' "$status" "$*"
  # Remove our own scratch copy last, and only if it looks like the one teardown.sh made.
  case "${LA_SELF_DELETE_SCRATCH:-}" in
    */la-uninstall.*) rm -rf "$LA_SELF_DELETE_SCRATCH" 2>/dev/null || true ;;
  esac
  [ "$status" = "ok" ] && exit 0
  exit 1
}

BUNDLE="${1:-}"
PID="${2:-}"

# --- is this really our bundle? --------------------------------------------
[ -n "$BUNDLE" ] || finish failed "no bundle path given"
case "$BUNDLE" in
  /*) : ;;
  *)  finish failed "refusing a relative path: ${BUNDLE}" ;;
esac
case "$BUNDLE" in
  *..*) finish failed "refusing a path containing '..': ${BUNDLE}" ;;
esac
[ "$(basename "$BUNDLE")" = "${EXECUTABLE_NAME}.app" ] \
  || finish failed "refusing ${BUNDLE}: not named ${EXECUTABLE_NAME}.app"
[ -d "$BUNDLE" ] || finish failed "refusing ${BUNDLE}: not a directory"
PARENT="$(dirname "$BUNDLE")"
case "$PARENT" in
  /|"$HOME") finish failed "refusing ${BUNDLE}: its parent is ${PARENT}" ;;
esac
[ -f "${BUNDLE}/Contents/MacOS/${EXECUTABLE_NAME}" ] \
  || finish failed "refusing ${BUNDLE}: no Contents/MacOS/${EXECUTABLE_NAME}"
grep -q "$BUNDLE_ID" "${BUNDLE}/Contents/Info.plist" 2>/dev/null \
  || finish failed "refusing ${BUNDLE}: its Info.plist does not declare ${BUNDLE_ID}"

# --- wait for the app to be gone -------------------------------------------
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  if [[ "$PID" =~ ^[0-9]+$ ]] && [ "$PID" -gt 1 ]; then
    log "waiting up to ${TIMEOUT}s for pid ${PID} to exit"
    deadline=$(( $(date +%s) + TIMEOUT ))
    while kill -0 "$PID" 2>/dev/null; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        # Never signalled. The app is not ours to kill, and removing a bundle out from
        # under a live process is exactly what this script exists to avoid.
        finish failed "pid ${PID} is still running after ${TIMEOUT}s; ${BUNDLE} was left in place"
      fi
      sleep 0.25
    done
    log "pid ${PID} is gone"
  else
    log "ignoring an implausible pid ${PID}"
  fi
fi

# --- remove it -------------------------------------------------------------
log "rm -rf ${BUNDLE}"
output="$(rm -rf "$BUNDLE" 2>&1)"
if [ -e "$BUNDLE" ]; then
  finish failed "could not remove ${BUNDLE}: ${output:-still present}"
fi
finish ok "removed ${BUNDLE}"
