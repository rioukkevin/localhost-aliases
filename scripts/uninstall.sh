#!/usr/bin/env bash
#
# uninstall.sh — undo install.sh, completely and reversibly.
#
# It removes, in this order:
#   1. the LaunchAgent   (gui/<uid>/dev.localhost-aliases.web + its plist)
#   2. the LaunchDaemon  (system/dev.localhost-aliases.helper + its plist)
#   3. the control socket
#   4. /usr/local/lib/localhost-aliases
#   5. the managed block in /etc/hosts, between the exact markers from
#      packages/core/src/types.ts — everything outside them is preserved
#   6. the DNS cache (flush, so the removed names stop resolving)
#
# Optional: --remove-ca (System keychain), --purge (config, CA material, logs).
#
# It never touches a path outside that list, and it is safe to run when nothing is
# installed: every step reports "already gone" and exits 0.

set -euo pipefail

LA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LA_SELF="$LA_SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. "$LA_SCRIPT_DIR/lib.sh"

REMOVE_CA=0
PURGE=0

usage() {
  cat <<'USAGE'
usage: ./scripts/uninstall.sh [options]

Always: unloads and deletes both launchd jobs, deletes /usr/local/lib/localhost-aliases
and the control socket, strips the managed block from /etc/hosts, flushes DNS.

Options:
  --remove-ca   Also delete "localhost-aliases Local CA" from the System keychain.
  --purge       Also delete ~/.config/localhost-aliases (config + CA key material),
                ~/Library/Logs/localhost-aliases and /var/log/localhost-aliases.
  --dry-run     Print every command that would change this machine, with all variables
                expanded, and run none of them. Needs no sudo.
  --prefix DIR  Operate on a sandbox tree under DIR instead of /. Needs no sudo.
  -h, --help    This text.

Environment:
  LA_USER       Owning user shortname. Defaults to SUDO_USER, then the console owner.
  LA_HOSTS_PATH Hosts file to strip the managed block from. Default /etc/hosts.
  DESTDIR       Same as --prefix.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --remove-ca) REMOVE_CA=1; shift ;;
    --purge) PURGE=1; shift ;;
    --dry-run) LA_DRY_RUN=1; shift ;;
    --prefix) [ $# -ge 2 ] || la_die "--prefix needs a directory"; LA_PREFIX="$2"; shift 2 ;;
    --prefix=*) LA_PREFIX="${1#--prefix=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; la_die "unknown option: $1" ;;
  esac
done

la_require_macos
la_apply_prefix

REEXEC=("$LA_SELF")
if [ "$REMOVE_CA" -eq 1 ]; then REEXEC+=("--remove-ca"); fi
if [ "$PURGE" -eq 1 ]; then REEXEC+=("--purge"); fi
la_reexec_with_sudo "${REEXEC[@]}"

la_require_root
la_resolve_user

AGENT_PLIST="$LA_HOME/Library/LaunchAgents/${LA_AGENT_LABEL}.plist"
USER_LOG_DIR="$LA_HOME/Library/Logs/localhost-aliases"
USER_CONFIG_DIR="${LA_CONFIG_DIR:-$LA_HOME/.config/localhost-aliases}"

HOSTS_CHANGED=0

# ---------------------------------------------------------------------------
# Deletion guard: nothing outside a directory literally named localhost-aliases.
# ---------------------------------------------------------------------------
remove_managed_dir() {
  local path="$1" label="$2"
  # A recursive delete only ever aimed at a directory literally named localhost-aliases.
  # An LA_CONFIG_DIR pointed somewhere else is reported, not deleted, and not fatal —
  # aborting here would leave the rest of the uninstall undone.
  case "$path" in
    /*/localhost-aliases) ;;
    *)
      la_warn "$label: '$path' does not end in /localhost-aliases — left in place.
      Delete it by hand if you want it gone."
      return 0
      ;;
  esac
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    la_info "$label: already gone"
    return 0
  fi
  la_run rm -rf "$path"
  [ "$LA_DRY_RUN" = "1" ] || la_ok "$label removed: $path"
}

remove_file() {
  local path="$1" label="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    la_info "$label: already gone"
    return 0
  fi
  la_run rm -f "$path"
  [ "$LA_DRY_RUN" = "1" ] || la_ok "$label removed: $path"
}

# ---------------------------------------------------------------------------
# launchd
# ---------------------------------------------------------------------------
unload_agent() {
  la_step "Removing the dashboard LaunchAgent"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "$LA_LAUNCHCTL bootout gui/$LA_UID/$LA_AGENT_LABEL   (if loaded)"
    remove_file "$AGENT_PLIST" "agent plist"
    return 0
  fi
  if "$LA_LAUNCHCTL" print "gui/$LA_UID" >/dev/null 2>&1; then
    if "$LA_LAUNCHCTL" print "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1; then
      la_user_launchctl bootout "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1 || true
      la_ok "booted out gui/$LA_UID/$LA_AGENT_LABEL"
    else
      la_info "gui/$LA_UID/$LA_AGENT_LABEL was not loaded"
    fi
  else
    la_info "no GUI session for $LA_USER — nothing to boot out"
  fi
  remove_file "$AGENT_PLIST" "agent plist"
}

unload_daemon() {
  la_step "Removing the privileged LaunchDaemon"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "$LA_LAUNCHCTL bootout system/$LA_HELPER_LABEL   (if loaded)"
    remove_file "$LA_HELPER_PLIST" "daemon plist"
    return 0
  fi
  if "$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" >/dev/null 2>&1; then
    "$LA_LAUNCHCTL" bootout "system/$LA_HELPER_LABEL" >/dev/null 2>&1 || true
    # bootout is asynchronous; give the helper a moment to release :80/:443.
    local i=0
    while [ "$i" -lt 20 ]; do
      if ! "$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" >/dev/null 2>&1; then break; fi
      sleep 0.25
      i=$((i + 1))
    done
    if "$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" >/dev/null 2>&1; then
      la_warn "system/$LA_HELPER_LABEL is still registered; removing the plist anyway.
      It will be gone after a reboot."
    else
      la_ok "booted out system/$LA_HELPER_LABEL"
    fi
  else
    la_info "system/$LA_HELPER_LABEL was not loaded"
  fi
  remove_file "$LA_HELPER_PLIST" "daemon plist"
}

# ---------------------------------------------------------------------------
# /etc/hosts
# ---------------------------------------------------------------------------
# Removes only the lines from HOSTS_BEGIN to HOSTS_END inclusive. Refuses to write
# anything at all if the markers are unbalanced (a truncated block means we cannot
# tell where user content resumes — a bad guess would eat the user's /etc/hosts).
# The new file is written next to the old one in /etc and rename()d over it, so a
# crash mid-write can never leave a half-written /etc/hosts behind.
strip_hosts_block() {
  la_step "Stripping the managed block from $LA_HOSTS_FILE"
  if [ ! -f "$LA_HOSTS_FILE" ]; then
    la_warn "$LA_HOSTS_FILE does not exist — skipped"
    return 0
  fi
  if ! /usr/bin/grep -qxF "$LA_HOSTS_BEGIN" "$LA_HOSTS_FILE"; then
    la_info "no managed block present"
    return 0
  fi

  local removed count tmp
  removed="$(/usr/bin/awk -v b="$LA_HOSTS_BEGIN" -v e="$LA_HOSTS_END" \
    '$0 == b { inblock = 1; next } $0 == e { inblock = 0; next } inblock' "$LA_HOSTS_FILE" || true)"
  count="$(printf '%s' "$removed" | /usr/bin/grep -c '[^[:space:]]' || true)"
  la_info "removing ${count:-0} managed line(s):"
  if [ -n "$removed" ]; then
    printf '%s\n' "$removed" | /usr/bin/sed 's/^/        /'
  fi

  # The temp file goes next to the hosts file, whatever that is, so the final mv is a
  # same-filesystem rename() and never a copy. (Hardcoding /etc broke LA_HOSTS_PATH.)
  # In dry-run there is no mv and no root, so it goes to TMPDIR instead — otherwise
  # `uninstall.sh --dry-run` as a normal user dies on mkstemp in /etc.
  local tmpdir
  if [ "$LA_DRY_RUN" = "1" ]; then
    tmpdir="${TMPDIR:-/tmp}"
  else
    tmpdir="$(dirname -- "$LA_HOSTS_FILE")"
  fi
  tmp="$(/usr/bin/mktemp "${tmpdir%/}/.localhost-aliases-hosts.XXXXXX")"
  if ! /usr/bin/awk -v b="$LA_HOSTS_BEGIN" -v e="$LA_HOSTS_END" '
        $0 == b { if (inblock) { bad = 1 } ; inblock = 1; next }
        $0 == e { if (!inblock) { bad = 1 } ; inblock = 0; next }
        !inblock { print }
        END { if (inblock || bad) { exit 3 } }
      ' "$LA_HOSTS_FILE" > "$tmp"; then
    rm -f "$tmp"
    la_die "the markers in $LA_HOSTS_FILE are unbalanced — refusing to rewrite it.
  Nothing was changed. Delete the block between
    $LA_HOSTS_BEGIN
    $LA_HOSTS_END
  by hand, then re-run."
  fi

  if [ ! -s "$tmp" ]; then
    la_warn "the result would be an empty $LA_HOSTS_FILE — refusing. Nothing changed."
    rm -f "$tmp"
    return 0
  fi

  if /usr/bin/cmp -s "$tmp" "$LA_HOSTS_FILE"; then
    rm -f "$tmp"
    la_info "$LA_HOSTS_FILE already clean"
    return 0
  fi

  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "rewrite $LA_HOSTS_FILE (root:wheel 0644) — diff of what would change:"
    /usr/bin/diff -u "$LA_HOSTS_FILE" "$tmp" | /usr/bin/sed 's/^/        /' || true
    rm -f "$tmp"
    return 0
  fi

  la_own root:wheel "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$LA_HOSTS_FILE"   # same filesystem => atomic rename()
  HOSTS_CHANGED=1
  la_ok "$LA_HOSTS_FILE rewritten (everything outside the markers preserved)"
}

flush_dns() {
  la_step "Flushing the DNS cache"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "/usr/bin/dscacheutil -flushcache"
    la_dry "/usr/bin/killall -HUP mDNSResponder"
    return 0
  fi
  # A sandbox uninstall never removed a real name, so there is nothing to flush.
  if [ -n "$LA_PREFIX" ]; then
    la_info "skipped (sandbox prefix — no real hostname was resolved through this)"
    return 0
  fi
  la_flush_dns
  la_ok "dscacheutil -flushcache + killall -HUP mDNSResponder"
}

# ---------------------------------------------------------------------------
# Optional extras
# ---------------------------------------------------------------------------
remove_ca() {
  la_step "Removing the local CA from the System keychain"
  local i=0
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "$LA_SECURITY delete-certificate -c '$LA_CA_COMMON_NAME' -t $LA_SYSTEM_KEYCHAIN   (until none are left)"
    return 0
  fi
  if ! "$LA_SECURITY" find-certificate -c "$LA_CA_COMMON_NAME" \
       "$LA_SYSTEM_KEYCHAIN" >/dev/null 2>&1; then
    la_info "'$LA_CA_COMMON_NAME' is not in the System keychain"
    return 0
  fi
  # add-trusted-cert can have been run more than once; delete until the name is gone.
  while [ "$i" -lt 10 ]; do
    if ! "$LA_SECURITY" find-certificate -c "$LA_CA_COMMON_NAME" \
         "$LA_SYSTEM_KEYCHAIN" >/dev/null 2>&1; then
      break
    fi
    if ! "$LA_SECURITY" delete-certificate -c "$LA_CA_COMMON_NAME" -t \
         "$LA_SYSTEM_KEYCHAIN" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
  done
  if "$LA_SECURITY" find-certificate -c "$LA_CA_COMMON_NAME" \
       "$LA_SYSTEM_KEYCHAIN" >/dev/null 2>&1; then
    la_warn "could not remove the CA. Do it by hand:
      sudo security delete-certificate -c \"$LA_CA_COMMON_NAME\" -t $LA_SYSTEM_KEYCHAIN"
  else
    la_ok "removed $i certificate(s) named '$LA_CA_COMMON_NAME'"
  fi
}

purge_user_data() {
  la_step "Purging configuration and logs"
  remove_managed_dir "$USER_CONFIG_DIR" "user config + CA material"
  remove_managed_dir "$USER_LOG_DIR" "dashboard logs"
  remove_managed_dir "$LA_DAEMON_LOG_DIR" "daemon logs"
}

summary() {
  printf '\n%s%sUninstalled.%s\n\n' "$LA_BOLD" "$LA_GREEN" "$LA_OFF"
  if [ "$HOSTS_CHANGED" -eq 1 ]; then
    printf '  %s no longer contains a localhost-aliases block.\n' "$LA_HOSTS_FILE"
  fi
  if [ "$PURGE" -eq 0 ]; then
    printf '  Kept (use --purge to delete):\n'
    printf '    config + CA   %s\n' "$USER_CONFIG_DIR"
    printf '    dashboard logs %s\n' "$USER_LOG_DIR"
    printf '    daemon logs    %s\n' "$LA_DAEMON_LOG_DIR"
  fi
  if [ "$REMOVE_CA" -eq 0 ]; then
    printf '  Kept: the "%s" root in the System keychain (use --remove-ca).\n' "$LA_CA_COMMON_NAME"
  fi
  printf '\n  Reinstall with: %s/install.sh\n\n' "$LA_SCRIPT_DIR"
}

main() {
  la_say "${LA_BOLD}localhost-aliases uninstaller${LA_OFF} — user ${LA_USER} (uid ${LA_UID})"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_warn "--dry-run: nothing below is executed"
  fi
  unload_agent
  unload_daemon
  remove_file "$LA_SOCKET_PATH" "control socket"
  remove_managed_dir "$LA_INSTALL_ROOT" "runtime"
  strip_hosts_block
  flush_dns
  if [ "$REMOVE_CA" -eq 1 ]; then remove_ca; fi
  if [ "$PURGE" -eq 1 ]; then purge_user_data; fi
  summary
}

main "$@"
