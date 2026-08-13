#!/bin/bash
#
# Reverses everything apply.sh did, in one pass, behind the same single admin prompt.
#
#   uninstall.sh
#
#   1. stop the root forwarder (and drop its liveness file so it exits even if we cannot)
#   2. remove our 127.0.0.2-254 aliases from lo0
#   3. strip the managed block from /etc/hosts, leaving the rest byte-for-byte
#   4. flush DNS
#
# It deletes nothing else. Not the config file, not the app, not a single line of
# /etc/hosts outside the markers — the unprivileged uninstaller removes
# ~/.config/localhost-aliases itself, because nothing there needs root.
#
# Environment:
#   LA_CONFIG_DIR   required
#   LA_FORWARDER    optional; without it the pid cannot be verified, so nothing is signalled
#   LA_HOSTS_PATH   default /etc/hosts
#   LA_LOG_DIR      default $LA_CONFIG_DIR/logs
#   LA_MANAGED_IPS  optional space-separated allow-list restricting lo0 removals further

set -Eeuo pipefail

LA_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "${LA_SELF_DIR}/lib.sh" ]; then
  printf 'LA_ERROR step=startup message=%s\n' "lib.sh is missing from ${LA_SELF_DIR}; ship the whole privileged directory" >&2
  printf 'LA_RESULT status=error step=startup\n'
  exit 1
fi
# shellcheck source=lib.sh
. "${LA_SELF_DIR}/lib.sh"

trap 'la_trap_err $?' ERR

LA_STEP="arguments"
[ "$#" -eq 0 ] || la_die "usage: uninstall.sh (no arguments)"
[ -n "${LA_CONFIG_DIR:-}" ] || la_die "LA_CONFIG_DIR is not set"

HOSTS_PATH="${LA_HOSTS_PATH:-/etc/hosts}"
LOG_DIR="${LA_LOG_DIR:-${LA_CONFIG_DIR}/logs}"
STATUS_FILE="${LA_CONFIG_DIR}/forwarder-status.json"
LIVENESS_FILE="${LA_CONFIG_DIR}/liveness"

la_open_log "$LOG_DIR"
la_log "uninstall.sh starting: hosts=${HOSTS_PATH}"
la_require_root

# ---------------------------------------------------------------------------
# 1. Forwarder
# ---------------------------------------------------------------------------
LA_STEP="forwarder"
FORWARDER_STATE="not-running"

# Removing the heartbeat is what guarantees the forwarder exits even if we never
# signal it: it watches this file and stops on its own when it goes stale.
rm -f "$LIVENESS_FILE" 2>/dev/null || true

if [ -n "${LA_FORWARDER:-}" ]; then
  running="$(la_forwarder_pid "$STATUS_FILE" "$LA_FORWARDER" || true)"
  if [ -n "$running" ]; then
    la_forwarder_stop "$running"
    FORWARDER_STATE="stopped"
  fi
else
  la_log "LA_FORWARDER is not set: leaving the process alone, it exits on its own without the heartbeat"
  FORWARDER_STATE="unverified"
fi
rm -f "$STATUS_FILE" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. lo0 — pool addresses only
# ---------------------------------------------------------------------------
LA_STEP="lo0"
IPS_REMOVED=0
LIVE_IPS="$(la_lo0_ips || true)"

for live in $LIVE_IPS; do
  la_is_pool_ip "$live" || continue
  if [ -n "${LA_MANAGED_IPS:-}" ]; then
    ours=0
    for managed in $LA_MANAGED_IPS; do [ "$managed" = "$live" ] && ours=1; done
    if [ "$ours" = "0" ]; then
      la_log "leaving ${live} on lo0: it is in the pool but not in LA_MANAGED_IPS"
      continue
    fi
  fi
  la_lo0_remove "$live"
  IPS_REMOVED=$((IPS_REMOVED + 1))
done

# ---------------------------------------------------------------------------
# 3. /etc/hosts
# ---------------------------------------------------------------------------
LA_STEP="hosts"
HOSTS_CHANGED=unchanged
if [ -f "$HOSTS_PATH" ]; then
  if la_hosts_write "$HOSTS_PATH" ""; then HOSTS_CHANGED=changed; fi
else
  la_log "${HOSTS_PATH} does not exist; nothing to strip"
fi

# ---------------------------------------------------------------------------
# 4. DNS
# ---------------------------------------------------------------------------
LA_STEP="dns"
la_flush_dns

LA_STEP="done"
la_log "uninstall.sh finished: -${IPS_REMOVED} lo0, hosts ${HOSTS_CHANGED}, forwarder ${FORWARDER_STATE}"
printf 'LA_RESULT status=ok ips_removed=%s hosts=%s dns=flushed forwarder=%s\n' \
  "$IPS_REMOVED" "$HOSTS_CHANGED" "$FORWARDER_STATE"
