#!/usr/bin/env bash
#
# `make uninstall` — the developer's way in. It owns NO teardown logic.
#
# Everything it used to do line by line now lives in packages/privileged/teardown.sh, which
# is shipped inside the .app. That is deliberate: the app must be able to uninstall itself
# with no source tree on the machine, and two copies of "what a full uninstall is" would
# drift the moment one of them was fixed. This script only locates the pieces and prints the
# report.
#
# It never runs sudo. teardown.sh raises the single admin prompt for the one step that
# needs root.
#
# Env: LA_TEARDOWN_ARGS (e.g. --dry-run), DIST.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# --- locate what is installed -----------------------------------------------
INSTALLED=""
for candidate in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app" "$APP"; do
  [ -d "$candidate" ] && { INSTALLED="$candidate"; break; }
done

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  die "$APP_NAME is running. Quit it from the menu bar first, then run 'make uninstall'. (Or use its own Uninstall… item, which handles the running case.)"
fi

# Prefer the scripts inside the installed bundle: they are the ones that were used, and on a
# machine where the checkout has moved on they are the ones that match what is installed.
TEARDOWN=""
for candidate in "${INSTALLED:+$INSTALLED/Contents/Resources/privileged}" "$ROOT/packages/privileged"; do
  [ -n "$candidate" ] && [ -f "$candidate/teardown.sh" ] && { TEARDOWN="$candidate/teardown.sh"; break; }
done
[ -n "$TEARDOWN" ] || die "no privileged/teardown.sh found — cannot revert the system changes safely"

FORWARDER=""
[ -n "$INSTALLED" ] && [ -x "$INSTALLED/Contents/Resources/forwarder" ] && FORWARDER="$INSTALLED/Contents/Resources/forwarder"

# The one place that knows where user state lives is core; do not second-guess it.
CONFIG_DIR="$(bun -e 'const { configDir } = await import("@localhost-aliases/core/paths"); console.log(configDir())' 2>/dev/null || echo "$HOME/.config/localhost-aliases")"
LOG_DIR="$(bun -e 'const { logDir } = await import("@localhost-aliases/core/paths"); console.log(logDir())' 2>/dev/null || echo "$HOME/Library/Logs/localhost-aliases")"

# --- is anything actually installed? ----------------------------------------
# `make uninstall` used to prompt for an administrator password, run the privileged revert and
# delete ~/Library/Logs/localhost-aliases on a machine where nothing was installed at all. The
# password bought nothing (there was nothing to revert) and the deletion was pure loss. Every
# question below is answerable without root, so ask them first.
# The marker comes from the shipped lib.sh, never from a fourth copy of the string here:
# core, lib.sh and the test that pins them together are the contract.
# shellcheck source=/dev/null
. "$(dirname "$TEARDOWN")/lib.sh"

EVIDENCE=""
[ -n "$INSTALLED" ] && EVIDENCE="$EVIDENCE the app,"
[ -d "$CONFIG_DIR" ] && EVIDENCE="$EVIDENCE your config,"
[ -d "$LOG_DIR" ] && EVIDENCE="$EVIDENCE its logs,"
grep -q -- "$LA_BEGIN_MARKER" "${LA_HOSTS_PATH:-/etc/hosts}" 2>/dev/null \
  && EVIDENCE="$EVIDENCE the /etc/hosts block,"
/sbin/ifconfig lo0 2>/dev/null \
  | awk '/inet 127\.0\.0\./ { split($2, o, "."); if (o[4] + 0 >= 2 && o[4] + 0 <= 254) found = 1 }
         END { exit !found }' \
  && EVIDENCE="$EVIDENCE loopback addresses,"

if [ -z "$EVIDENCE" ]; then
  # dist/ is deliberately left alone here: on a clean Mac it is the built bundle you are
  # about to `make install`, not a leftover.
  step "Nothing to uninstall"
  info "No app, no $CONFIG_DIR, no logs, no managed /etc/hosts block and no 127.0.0.x"
  info "addresses on lo0 — this Mac is already clean. Nothing ran, and no password was asked for."
  exit 0
fi

step "Uninstalling"
info "$TEARDOWN"
info "found:${EVIDENCE%,}"
info "config: $CONFIG_DIR"
info "app:    ${INSTALLED:-none installed}"

# No LA_WAIT_PID: the app is not running (checked above), so the bundle is removed inline.
set +e
LA_CONFIG_DIR="$CONFIG_DIR" \
LA_LOG_DIR="$LOG_DIR" \
LA_APP_BUNDLE="$INSTALLED" \
LA_FORWARDER="$FORWARDER" \
  /bin/bash "$TEARDOWN" ${LA_TEARDOWN_ARGS:-} | while IFS= read -r line; do
    case "$line" in
      "LA_STEP "*)   printf '    %s\n' "${line#LA_STEP }" ;;
      "LA_RESULT "*) printf '\033[1m==>\033[0m %s\n' "${line#LA_RESULT }" ;;
      *)             printf '    %s\n' "$line" ;;
    esac
  done
STATUS="${PIPESTATUS[0]}"
set -e

# dist/ is a build artifact of this checkout, not something teardown.sh knows about. A dry run
# or a dismissed prompt removed nothing, so it must not remove this either — "print what you
# would do" that deletes the build you were about to install is not a dry run.
case " ${LA_TEARDOWN_ARGS:-} " in
  *" --dry-run "*|*" --print-only "*) info "dry run: $DIST was left alone" ;;
  *) [ "$STATUS" = "2" ] || rm -rf "$DIST" ;;
esac

case "$STATUS" in
  0) step "Uninstalled"
     info "Your projects are untouched, and /etc/hosts keeps every line outside the managed block." ;;
  2) step "Cancelled"
     info "The password prompt was dismissed, so nothing was removed." ;;
  *) step "Uninstalled, with failures"
     info "The steps above that say 'failed' were skipped over deliberately — every other step still ran."
     info "Fix what failed and run 'make uninstall' again; it is safe to repeat." ;;
esac
exit "$STATUS"
