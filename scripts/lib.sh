#!/usr/bin/env bash
#
# lib.sh — constants and helpers shared by install.sh, uninstall.sh and dev.sh.
#
# This file is *sourced*, never executed. It exists so that the launchd labels and
# filesystem paths have exactly one definition on the shell side: if install.sh and
# uninstall.sh ever disagreed about a label or a path, uninstall would silently leave
# a root daemon running. Keep the constants below in sync with the frozen contract in
# packages/core/src/paths.ts and packages/core/src/types.ts.

# The constants below are read by the scripts that source this file; static
# analysis cannot see those uses from in here, so SC2034 is off for the file.
# shellcheck disable=SC2034

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo "lib.sh is a library: source it, do not run it." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Frozen contract — mirrors packages/core/src/paths.ts
# ---------------------------------------------------------------------------
LA_HELPER_LABEL="dev.localhost-aliases.helper"
LA_AGENT_LABEL="dev.localhost-aliases.web"
LA_INSTALL_ROOT="/usr/local/lib/localhost-aliases"
LA_SOCKET_PATH="/var/run/localhost-aliases.sock"
LA_HELPER_PLIST="/Library/LaunchDaemons/${LA_HELPER_LABEL}.plist"
LA_DAEMON_LOG_DIR="/var/log/localhost-aliases"
LA_HOSTS_FILE="${LA_HOSTS_PATH:-/etc/hosts}"
LA_SYSTEM_KEYCHAIN="/Library/Keychains/System.keychain"
LA_DASHBOARD_PORT_DEFAULT="7788"

# mirrors packages/core/src/types.ts — uninstall depends on these byte-for-byte
LA_HOSTS_BEGIN="# >>> localhost-aliases >>>"
LA_HOSTS_END="# <<< localhost-aliases <<<"

# mirrors CA_COMMON_NAME in packages/core/src/certs.ts
LA_CA_COMMON_NAME="localhost-aliases Local CA"

# PATH handed to launchd jobs. launchd gives a job almost nothing, so it is spelled out.
LA_LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ---------------------------------------------------------------------------
# Modes: --dry-run and --prefix
# ---------------------------------------------------------------------------
# LA_DRY_RUN=1  print every mutating command with its variables expanded, run none.
# LA_PREFIX=DIR relocate every absolute system path under DIR (DESTDIR-style), so the
#               whole install can be exercised against a sandbox instead of /.
# Both are set from the command line by install.sh / uninstall.sh.
LA_DRY_RUN="${LA_DRY_RUN:-0}"
LA_PREFIX="${LA_PREFIX:-${DESTDIR:-}}"

# External tools, addressed by absolute path so a hostile PATH cannot substitute them.
# Overridable only so the test harness can point them at logging stubs.
LA_LAUNCHCTL="${LA_LAUNCHCTL:-/bin/launchctl}"
LA_SECURITY="${LA_SECURITY:-/usr/bin/security}"
LA_SUDO="${LA_SUDO:-/usr/bin/sudo}"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  LA_DIM=$'\033[2m'; LA_BOLD=$'\033[1m'; LA_RED=$'\033[31m'
  LA_GREEN=$'\033[32m'; LA_YELLOW=$'\033[33m'; LA_BLUE=$'\033[34m'; LA_OFF=$'\033[0m'
else
  LA_DIM=""; LA_BOLD=""; LA_RED=""; LA_GREEN=""; LA_YELLOW=""; LA_BLUE=""; LA_OFF=""
fi

la_say()  { printf '%s\n' "$*"; }
la_step() { printf '%s==>%s %s%s%s\n' "$LA_BLUE" "$LA_OFF" "$LA_BOLD" "$*" "$LA_OFF"; }
la_ok()   { printf '    %s✓%s %s\n' "$LA_GREEN" "$LA_OFF" "$*"; }
la_info() { printf '    %s·%s %s\n' "$LA_DIM" "$LA_OFF" "$*"; }
la_warn() { printf '    %s!%s %s\n' "$LA_YELLOW" "$LA_OFF" "$*" >&2; }
la_die()  { printf '%serror:%s %s\n' "$LA_RED" "$LA_OFF" "$*" >&2; exit 1; }
la_dry()  { printf '    %s[dry-run]%s %s\n' "$LA_YELLOW" "$LA_OFF" "$*"; }

# ---------------------------------------------------------------------------
# Mutation
# ---------------------------------------------------------------------------
# Every command that changes the machine goes through la_run. In dry-run it is printed
# with all variables already expanded and nothing is executed; the return code is 0, so
# `if ! la_run ...` branches take the success path and the walkthrough keeps going.
la_run() {
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "$(la_cmdline "$@")"
    return 0
  fi
  "$@"
}

# la_run for commands whose own chatter we discard. The redirection lives *inside* the
# function on purpose: `la_run cmd >/dev/null` would also swallow the dry-run line.
la_run_quiet() {
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "$(la_cmdline "$@")"
    return 0
  fi
  "$@" >/dev/null 2>&1
}

# Render an argv for humans: quote only the words that need it, so the printed line is
# both readable and safe to paste back into a shell.
la_cmdline() {
  local out="" arg
  for arg in "$@"; do
    case "$arg" in
      ""|*[!A-Za-z0-9_/.:=@%+,-]*) out="$out $(printf '%q' "$arg")" ;;
      *) out="$out $arg" ;;
    esac
  done
  printf '%s' "${out# }"
}

# chown, skipped when we are not root (the --prefix sandbox runs unprivileged, and
# there is nothing meaningful to hand over when every file is already ours).
la_own() {
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi
  la_run /usr/sbin/chown "$@"
}

# Write a file the atomic way, in two halves so the caller can validate the staged
# content (plutil -lint) before anything is moved into place.
#
#   tmp="$(la_stage_file "$dest" <<EOF ... EOF)"
#   la_commit_file "$tmp" "$dest" 0644 root wheel
#
# la_stage_file prints the temp path. In dry-run the temp is created under TMPDIR so
# nothing at all appears next to the real destination.
la_stage_file() {
  local dest="$1" dir tmp
  if [ "$LA_DRY_RUN" = "1" ]; then
    dir="${TMPDIR:-/tmp}"
  else
    dir="$(dirname -- "$dest")"
    mkdir -p "$dir"
  fi
  tmp="$(/usr/bin/mktemp "${dir%/}/.localhost-aliases-stage.XXXXXX")" || return 1
  cat >"$tmp"
  printf '%s\n' "$tmp"
}

la_commit_file() {
  local tmp="$1" dest="$2" mode="$3" owner="${4:-}" group="${5:-}"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "write $dest (mode $mode${owner:+, owner $owner:$group}), content:"
    /usr/bin/sed 's/^/        /' "$tmp"
    rm -f "$tmp"
    return 0
  fi
  if [ -n "$owner" ]; then
    la_own "$owner:$group" "$tmp"
  fi
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

# Escape a value for interpolation into plist XML. Paths and shortnames are attacker-free
# in practice, but a home directory containing '&' would otherwise emit invalid XML.
la_xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------
# Relocate every absolute system path under LA_PREFIX. Called once, right after option
# parsing, before any path is used. A no-op in the production case (empty prefix).
la_apply_prefix() {
  [ -n "$LA_PREFIX" ] || return 0
  case "$LA_PREFIX" in
    /*) ;;
    *) la_die "--prefix must be an absolute path (got '$LA_PREFIX')" ;;
  esac
  LA_PREFIX="${LA_PREFIX%/}"
  LA_INSTALL_ROOT="$LA_PREFIX$LA_INSTALL_ROOT"
  LA_SOCKET_PATH="$LA_PREFIX$LA_SOCKET_PATH"
  LA_HELPER_PLIST="$LA_PREFIX$LA_HELPER_PLIST"
  LA_DAEMON_LOG_DIR="$LA_PREFIX$LA_DAEMON_LOG_DIR"
  LA_SYSTEM_KEYCHAIN="$LA_PREFIX$LA_SYSTEM_KEYCHAIN"
  # An explicit LA_HOSTS_PATH is already a redirection; do not relocate it twice.
  if [ -z "${LA_HOSTS_PATH:-}" ]; then
    LA_HOSTS_FILE="$LA_PREFIX$LA_HOSTS_FILE"
  fi
  la_info "sandbox prefix: $LA_PREFIX (nothing outside it is touched)"
}

# This whole system is launchd + /etc/hosts + the macOS keychain. Refuse elsewhere.
la_require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    la_die "localhost-aliases is macOS-only (launchd, dscacheutil, security). Detected: $(uname -s)."
  fi
}

la_require_root() {
  if [ "$(id -u)" -eq 0 ]; then
    return 0
  fi
  # --dry-run mutates nothing and --prefix mutates only the sandbox, so neither needs root.
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_info "not root — fine, --dry-run changes nothing"
    return 0
  fi
  if [ -n "$LA_PREFIX" ]; then
    la_info "not root — writing into $LA_PREFIX only; ownership changes are skipped"
    return 0
  fi
  la_die "must run as root. Re-run with sudo."
}

# Re-exec the current script under sudo. sudo sets SUDO_USER for us, which is how the
# human's uid survives into LA_OWNER_UID. Call as: la_reexec_with_sudo "$LA_SELF" [flags...]
#
# sudo's env_reset wipes the environment, so the documented LA_* overrides have to be
# carried across explicitly. They are handed to /usr/bin/env rather than to sudo itself,
# because sudo's own VAR=value handling depends on the sudoers policy.
la_reexec_with_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    return 0
  fi
  # Neither mode touches anything root owns, so do not ask for a password.
  if [ "$LA_DRY_RUN" = "1" ] || [ -n "$LA_PREFIX" ]; then
    return 0
  fi
  local env_args v
  env_args=("LA_REEXECED=1")
  for v in LA_USER LA_CONFIG_DIR LA_DASHBOARD_PORT LA_HOSTS_PATH LA_LOG_DIR NO_COLOR; do
    if [ -n "${!v:-}" ]; then
      env_args+=("$v=${!v}")
    fi
  done
  la_info "not root yet — re-executing under sudo"
  # Re-exec through the interpreter, not the file, so this works even when the
  # script was invoked as `bash scripts/install.sh` and has no executable bit.
  exec "$LA_SUDO" -p "[sudo] password for %u (localhost-aliases needs root): " -- \
    /usr/bin/env "${env_args[@]}" "${BASH:-/bin/bash}" "$@"
}

# ---------------------------------------------------------------------------
# Identity: which human is this install for?
# ---------------------------------------------------------------------------
# Sets LA_USER / LA_UID / LA_GROUP / LA_HOME. Must be called while root.
# Order: LA_USER override -> SUDO_USER (the normal path) -> console owner.
la_resolve_user() {
  local candidate=""
  if [ -n "${LA_USER:-}" ]; then
    candidate="$LA_USER"
  elif [ -n "${SUDO_USER:-}" ]; then
    candidate="$SUDO_USER"
  elif [ -e /dev/console ]; then
    candidate="$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)"
  fi

  if [ -z "$candidate" ] || [ "$candidate" = "root" ]; then
    la_die "cannot determine the owning user.
  Run this from your normal account (it will sudo itself), or set LA_USER=<shortname>.
  Installing with LA_OWNER_UID=0 would hand the control socket to root only."
  fi

  if ! /usr/bin/id -u "$candidate" >/dev/null 2>&1; then
    la_die "user '$candidate' does not exist on this machine."
  fi

  LA_USER="$candidate"
  LA_UID="$(/usr/bin/id -u "$LA_USER")"
  LA_GROUP="$(/usr/bin/id -gn "$LA_USER")"
  LA_HOME="$(/usr/bin/dscl . -read "/Users/$LA_USER" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')"
  if [ -z "$LA_HOME" ] || [ ! -d "$LA_HOME" ]; then
    LA_HOME="/Users/$LA_USER"
  fi
  if [ ! -d "$LA_HOME" ]; then
    la_die "home directory for '$LA_USER' not found (tried $LA_HOME)."
  fi

  # In a sandbox run the "home" is a mirror inside the prefix, so LaunchAgents and logs
  # land there instead of in the real one.
  if [ -n "$LA_PREFIX" ]; then
    LA_HOME="$LA_PREFIX$LA_HOME"
    if [ "$LA_DRY_RUN" != "1" ]; then
      mkdir -p "$LA_HOME"
    fi
  fi
}

# Run a command as the owning user, with their environment. When we are not root we
# already are that user, so there is nothing to drop to (and no reason to prompt).
la_run_as_user() {
  if [ "$(id -u)" -ne 0 ]; then
    la_run "$@"
    return
  fi
  la_run "$LA_SUDO" -u "$LA_USER" -H "$@"
}

# Run launchctl inside the owning user's GUI bootstrap context (for LaunchAgents).
la_user_launchctl() {
  if [ "$(id -u)" -ne 0 ]; then
    "$LA_LAUNCHCTL" "$@"
    return
  fi
  "$LA_LAUNCHCTL" asuser "$LA_UID" "$LA_SUDO" -u "$LA_USER" "$LA_LAUNCHCTL" "$@"
}

# ---------------------------------------------------------------------------
# bun
# ---------------------------------------------------------------------------
# Prints the absolute path of a usable bun, or exits with install instructions.
# Looks first at the *invoking human's* PATH (root's PATH does not have Homebrew or
# ~/.bun in it), then at the two places bun installs itself on macOS.
la_find_bun() {
  local found="" candidate homedir
  homedir="${LA_HOME:-$HOME}"

  if [ "$(id -u)" -eq 0 ] && [ -n "${LA_USER:-}" ]; then
    local login_shell
    login_shell="$(/usr/bin/dscl . -read "/Users/$LA_USER" UserShell 2>/dev/null | /usr/bin/awk '{print $2}')"
    if [ ! -x "${login_shell:-}" ]; then login_shell="/bin/bash"; fi
    # tail -n 1: a chatty login profile must not end up in the path we return.
    found="$("$LA_SUDO" -u "$LA_USER" -H "$login_shell" -lc 'command -v bun' 2>/dev/null | /usr/bin/tail -n 1 || true)"
  else
    found="$(command -v bun 2>/dev/null || true)"
  fi

  if [ -z "$found" ] || [ ! -x "$found" ]; then
    found=""
    for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun "$homedir/.bun/bin/bun"; do
      if [ -x "$candidate" ]; then
        found="$candidate"
        break
      fi
    done
  fi

  if [ -z "$found" ]; then
    la_die "bun was not found.
  Looked in: your login PATH, /opt/homebrew/bin/bun, /usr/local/bin/bun, $homedir/.bun/bin/bun

  Install it, then re-run this script:
      brew install oven-sh/bun/bun
    or
      curl -fsSL https://bun.sh/install | bash"
  fi

  printf '%s\n' "$found"
}

# PATH for a launchd job (or the dev helper): bun's directory first, without
# duplicating it when bun already lives somewhere on the standard PATH.
la_launchd_path_for() {
  local dir="$1"
  case ":$LA_LAUNCHD_PATH:" in
    *":$dir:"*) printf '%s\n' "$LA_LAUNCHD_PATH" ;;
    *) printf '%s\n' "$dir:$LA_LAUNCHD_PATH" ;;
  esac
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------
# The only two commands macOS offers. Both are best-effort: a failure here is never
# fatal, it only means stale name resolution until the next cache expiry.
la_flush_dns() {
  /usr/bin/dscacheutil -flushcache >/dev/null 2>&1 || true
  /usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true
}
