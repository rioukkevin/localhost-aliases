#!/bin/bash
#
# The WHOLE uninstall, in one place, for both callers.
#
#   teardown.sh [--dry-run]
#
# `make uninstall` and the app's own "Uninstall…" run this same file, so the two can never
# drift. It is shipped inside the bundle (Contents/Resources/privileged/), which is what
# makes an uninstall possible with no source tree anywhere on the machine.
#
# THIS SCRIPT IS NOT PRIVILEGED. It runs as the user and *raises* one admin prompt for the
# one step that needs root — exactly like prompt.ts does for apply.
#
#   1. system   ONE admin prompt -> uninstall.sh beside this file, as root:
#               stop the root agent, drop our lo0 addresses, strip the /etc/hosts managed
#               block, flush DNS, and hand back anything root created in the user's dirs.
#   2. ca       remove the local CA from the LOGIN keychain, matched by SHA-1 fingerprint.
#   3. config   remove $LA_CONFIG_DIR.
#   4. logs     remove $LA_LOG_DIR.
#   5. app      remove the .app — via self-delete.sh, copied OUT of the bundle first,
#               because a running app cannot reliably delete its own bundle.
#
# EVERY STEP REPORTS AND CONTINUES.
# A real run died at step 3 on a root-owned logs/ directory and therefore never reached
# step 5: the user was left with an app that had already torn down its own system state and
# could not remove itself. A half-finished teardown is worse than a reported failure, so
# nothing here aborts the sequence. The one exception is a CANCELLED password prompt, which
# is a decision, not a failure: it stops before anything is removed.
#
# Environment (all optional unless marked):
#   LA_CONFIG_DIR    required. ~/.config/localhost-aliases.
#   LA_LOG_DIR       default ~/Library/Logs/localhost-aliases
#   LA_APP_BUNDLE    the .app to remove. Unset = leave the app alone (step 5 skipped).
#   LA_WAIT_PID      pid to outlive before the bundle is removed — the running app itself.
#   LA_FORWARDER     absolute path to the forwarder binary, so root can verify its pid.
#   LA_MANAGED_IPS   space-separated lo0 addresses this install allocated. Derived from
#                    config.json when unset; unset+underivable means "the whole pool".
#   LA_HOSTS_PATH    tests only. Passed through to the privileged half.
#   LA_KEYCHAIN      default ~/Library/Keychains/login.keychain-db
#   LA_OSASCRIPT / LA_SECURITY / LA_OPENSSL   binaries, overridable so tests can stub them.
#   LA_DRY_RUN=1     same as --dry-run: print the exact commands, run none of them.
#
# Output protocol (stdout, machine-readable, one line per step):
#   LA_STEP <name> <ok|failed|skipped|scheduled|dry-run> <detail…>
#   LA_RESULT status=<ok|partial|cancelled> failed=<n> app=<removed|scheduled|kept|skipped>
# Exit: 0 everything done, 1 something failed (and the rest still ran), 2 prompt cancelled.

set -uo pipefail

LA_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

OSASCRIPT="${LA_OSASCRIPT:-/usr/bin/osascript}"
SECURITY="${LA_SECURITY:-/usr/bin/security}"
OPENSSL="${LA_OPENSSL:-/usr/bin/openssl}"

DRY_RUN="${LA_DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    --dry-run|--print-only) DRY_RUN=1 ;;
    *) printf 'usage: teardown.sh [--dry-run]\n' >&2; exit 2 ;;
  esac
done

CONFIG_DIR="${LA_CONFIG_DIR:-}"
if [ -z "$CONFIG_DIR" ]; then
  printf 'LA_STEP startup failed LA_CONFIG_DIR is not set\n'
  printf 'LA_RESULT status=partial failed=1 app=skipped\n'
  exit 1
fi
LOG_DIR="${LA_LOG_DIR:-${HOME}/Library/Logs/localhost-aliases}"
KEYCHAIN="${LA_KEYCHAIN:-${HOME}/Library/Keychains/login.keychain-db}"
APP_BUNDLE="${LA_APP_BUNDLE:-}"
WAIT_PID="${LA_WAIT_PID:-}"
CA_CERT="${CONFIG_DIR}/ca/rootCA.pem"
OWNER="$(id -u):$(id -g)"

FAILED=0
APP_OUTCOME="skipped"

say() { printf '%s\n' "$*" >&2; }
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
asq() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
# The protocol is line-based, so a detail must never contain a newline.
oneline() { printf '%s' "$*" | tr '\n\r' '  ' | sed 's/[[:space:]]\{2,\}/ /g'; }

step_ok()        { printf 'LA_STEP %s ok %s\n' "$1" "$(oneline "${*:2}")"; }
step_skipped()   { printf 'LA_STEP %s skipped %s\n' "$1" "$(oneline "${*:2}")"; }
step_scheduled() { printf 'LA_STEP %s scheduled %s\n' "$1" "$(oneline "${*:2}")"; }
step_dry()       { printf 'LA_STEP %s dry-run %s\n' "$1" "$(oneline "${*:2}")"; }
step_failed()    { FAILED=$((FAILED + 1)); printf 'LA_STEP %s failed %s\n' "$1" "$(oneline "${*:2}")"; }

# ---------------------------------------------------------------------------
# 1. system — the one admin prompt
# ---------------------------------------------------------------------------
# LA_OWNER is not optional here. Without it root creates logs/ and privileged.log inside
# the user's own config directory as root:wheel, and step 3 below then cannot delete them.

UNINSTALL_SH="${LA_SELF_DIR}/uninstall.sh"

managed_ips() {
  if [ -n "${LA_MANAGED_IPS:-}" ]; then printf '%s' "$LA_MANAGED_IPS"; return 0; fi
  local config="${CONFIG_DIR}/config.json"
  [ -f "$config" ] || return 0
  # Only ever NARROWS what root removes from lo0, and only matches our own pool shape.
  # Finding nothing leaves LA_MANAGED_IPS unset, i.e. the documented "the pool is ours".
  grep -o '"ip"[[:space:]]*:[[:space:]]*"127\.0\.0\.[0-9]\{1,3\}"' "$config" 2>/dev/null \
    | grep -o '127\.0\.0\.[0-9]\{1,3\}' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

privileged_command() {
  local cmd="/usr/bin/env"
  cmd="$cmd LA_CONFIG_DIR=$(shq "$CONFIG_DIR")"
  cmd="$cmd LA_LOG_DIR=$(shq "$LOG_DIR")"
  cmd="$cmd LA_OWNER=$(shq "$OWNER")"
  [ -n "${LA_FORWARDER:-}" ] && cmd="$cmd LA_FORWARDER=$(shq "$LA_FORWARDER")"
  [ -n "${LA_HOSTS_PATH:-}" ] && cmd="$cmd LA_HOSTS_PATH=$(shq "$LA_HOSTS_PATH")"
  local ips; ips="$(managed_ips)"
  [ -n "$ips" ] && cmd="$cmd LA_MANAGED_IPS=$(shq "$ips")"
  printf '%s /bin/bash %s' "$cmd" "$(shq "$UNINSTALL_SH")"
}

step_system() {
  if [ ! -f "$UNINSTALL_SH" ]; then
    step_failed system "no uninstall.sh beside ${LA_SELF_DIR} — the system changes were left in place"
    return
  fi
  local command; command="$(privileged_command)"
  if [ "$DRY_RUN" = "1" ]; then
    step_dry system "$OSASCRIPT -e do shell script \"${command}\" with administrator privileges"
    return
  fi

  say "==> Reverting the system changes (macOS will ask for your password once)"
  local output status
  output="$("$OSASCRIPT" -e "do shell script \"$(asq "$command")\" with administrator privileges" 2>&1)"
  status=$?
  say "$output"
  if [ "$status" = "0" ]; then
    step_ok system "hosts block, lo0 addresses, DNS and the root agent"
    return
  fi
  # A dismissed dialog is a decision, not a failure. Everything after this point deletes the
  # user's files, so "no" has to mean nothing is deleted.
  case "$output" in
    *"-128"*|*"User canceled"*|*"User cancelled"*)
      printf 'LA_STEP system cancelled the administrator prompt was dismissed — nothing was removed\n'
      printf 'LA_RESULT status=cancelled failed=0 app=kept\n'
      exit 2 ;;
  esac
  step_failed system "$(oneline "$output")"
}

# ---------------------------------------------------------------------------
# 2. ca — the local CA in the LOGIN keychain (the user's, never root's)
# ---------------------------------------------------------------------------

step_ca() {
  if [ ! -f "$CA_CERT" ]; then
    step_skipped ca "no ${CA_CERT} — nothing was ever trusted"
    return
  fi
  local sha1
  sha1="$("$OPENSSL" x509 -in "$CA_CERT" -noout -fingerprint -sha1 2>/dev/null | cut -d= -f2 | tr -d ':')"
  if [ -z "$sha1" ]; then
    step_failed ca "could not read a SHA-1 fingerprint from ${CA_CERT}; delete it by hand in Keychain Access"
    return
  fi
  # By fingerprint, NEVER by name: deleting the wrong certificate is unrecoverable.
  if [ "$DRY_RUN" = "1" ]; then
    step_dry ca "$SECURITY delete-certificate -Z ${sha1} -t ${KEYCHAIN}"
    return
  fi
  if "$SECURITY" delete-certificate -Z "$sha1" -t "$KEYCHAIN" >/dev/null 2>&1; then
    step_ok ca "removed ${sha1} from ${KEYCHAIN}"
  else
    # Not being there is the normal case for anyone who skipped the https step.
    step_skipped ca "${sha1} is not in ${KEYCHAIN} (already gone)"
  fi
}

# ---------------------------------------------------------------------------
# 3 + 4. the user's own directories
# ---------------------------------------------------------------------------

# Paths that are never ours, whatever an environment variable says.
#
# LA_CONFIG_DIR and LA_LOG_DIR are honoured all the way down — paths.ts reads them, Paths.swift
# mirrors them, and `make uninstall` asks paths.ts. That is deliberate (every test sets them),
# but it also means a stale `export LA_CONFIG_DIR=…` left in a shell decides what `rm -rf` gets
# handed. self-delete.sh already refuses to believe the path it is given; this is the same
# refusal for the two directory steps. It costs nothing and it is the difference between a
# reported failure and someone's home directory.
never_ours() { # <path> -> 0 when the path must NEVER be removed
  local p="${1%/}"
  [ -n "$p" ] || return 0
  case "$p" in
    /|/bin|/sbin|/usr|/etc|/var|/tmp|/opt|/dev|/cores|/Users|/Volumes \
    |/Applications|/Library|/System|/private|/private/tmp|/private/var \
    |"${HOME%/}"|"${HOME%/}"/.config|"${HOME%/}"/Library|"${HOME%/}"/Library/Logs \
    |"${HOME%/}"/Applications|"${HOME%/}"/Desktop|"${HOME%/}"/Documents|"${HOME%/}"/Downloads)
      return 0 ;;
  esac
  # …and nothing that CONTAINS the home directory, e.g. /Users or /System/Volumes/Data/Users.
  case "${HOME%/}/" in "$p"/*) return 0 ;; esac
  return 1
}

remove_dir() { # <step> <path> <what>
  local name="$1" path="$2" what="$3"
  if [ -z "$path" ] || never_ours "$path"; then
    step_failed "$name" "refusing to remove ${path:-an empty path} — that is never this app's directory"
    return
  fi
  if [ ! -e "$path" ]; then
    step_skipped "$name" "${path} does not exist"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    step_dry "$name" "/bin/rm -rf ${path}"
    return
  fi
  local output status
  output="$(/bin/rm -rf "$path" 2>&1)"
  status=$?
  if [ "$status" = "0" ] && [ ! -e "$path" ]; then
    step_ok "$name" "removed ${path} (${what})"
  else
    step_failed "$name" "could not remove ${path}: $(oneline "${output:-still present}")"
  fi
}

# ---------------------------------------------------------------------------
# 5. app — the bundle, last, and from OUTSIDE itself
# ---------------------------------------------------------------------------

step_app() {
  if [ -z "$APP_BUNDLE" ]; then
    step_skipped app "no LA_APP_BUNDLE given — the app was left alone"
    return
  fi
  if [ ! -d "$APP_BUNDLE" ]; then
    APP_OUTCOME="removed"
    step_skipped app "${APP_BUNDLE} does not exist"
    return
  fi

  local helper="${LA_SELF_DIR}/self-delete.sh"
  if [ ! -f "$helper" ]; then
    step_failed app "no self-delete.sh beside ${LA_SELF_DIR}; remove ${APP_BUNDLE} by hand"
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    step_dry app "/bin/bash <scratch>/self-delete.sh ${APP_BUNDLE} ${WAIT_PID:-0}"
    return
  fi

  # The helper CANNOT run from inside the bundle it deletes: bash reads a script as it goes,
  # and the file would vanish mid-execution. Copy it out first, always — the foreground and
  # background paths then share one code path and cannot drift.
  local scratch
  local tmp="${TMPDIR:-/tmp}"
  scratch="$(mktemp -d "${tmp%/}/la-uninstall.XXXXXX")" || {
    step_failed app "could not create a scratch directory for self-delete.sh"
    return
  }
  cp "$helper" "$scratch/self-delete.sh" 2>/dev/null && chmod +x "$scratch/self-delete.sh" || {
    rm -rf "$scratch"
    step_failed app "could not copy self-delete.sh out of the bundle"
    return
  }

  local helper_log="${TMPDIR:-/tmp}/localhost-aliases-uninstall.log"
  helper_log="${helper_log//\/\///}"
  if [ -n "$WAIT_PID" ]; then
    # Detached: it outlives this script AND the app. stdout/stderr go to the log, not to our
    # pipe — a caller reading our output to EOF would otherwise block on this child.
    LA_SELF_DELETE_SCRATCH="$scratch" LA_SELF_DELETE_LOG="$helper_log" \
      /bin/bash "$scratch/self-delete.sh" "$APP_BUNDLE" "$WAIT_PID" \
      >>"$helper_log" 2>&1 </dev/null &
    disown $! 2>/dev/null || true
    APP_OUTCOME="scheduled"
    step_scheduled app "${APP_BUNDLE} is removed once pid ${WAIT_PID} exits; log: ${helper_log}"
    return
  fi

  local output status
  output="$(LA_SELF_DELETE_SCRATCH="$scratch" LA_SELF_DELETE_LOG="$helper_log" \
    /bin/bash "$scratch/self-delete.sh" "$APP_BUNDLE" 2>&1)"
  status=$?
  if [ "$status" = "0" ]; then
    APP_OUTCOME="removed"
    step_ok app "removed ${APP_BUNDLE}"
  else
    APP_OUTCOME="kept"
    step_failed app "$(oneline "$output")"
  fi
}

# ---------------------------------------------------------------------------
# The sequence. Nothing between these calls may abort it.
# ---------------------------------------------------------------------------

say "==> Uninstalling Localhost Aliases"
[ "$DRY_RUN" = "1" ] && say "    dry run: printing the commands, running none of them"

step_system
step_ca
remove_dir config "$CONFIG_DIR" "your aliases and settings"
remove_dir logs "$LOG_DIR" "the app's own logs"
step_app

if [ "$DRY_RUN" = "1" ]; then
  printf 'LA_RESULT status=ok failed=0 app=dry-run\n'
  exit 0
fi

if [ "$FAILED" = "0" ]; then
  printf 'LA_RESULT status=ok failed=0 app=%s\n' "$APP_OUTCOME"
  exit 0
fi
printf 'LA_RESULT status=partial failed=%s app=%s\n' "$FAILED" "$APP_OUTCOME"
exit 1
