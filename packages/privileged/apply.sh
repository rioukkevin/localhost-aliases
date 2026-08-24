#!/bin/bash
#
# The single privileged entrypoint of localhost-aliases v2.
#
#   apply.sh [--restart-forwarder] [--no-forwarder] <desired-state.json>
#
# Run as root, once, behind ONE macOS admin prompt — at app launch. Idempotent: running
# it twice in a row changes nothing the second time. It does exactly four things:
#
#   1. add missing 127.0.0.2-254 aliases to lo0, remove ours that are no longer wanted
#   2. rewrite the managed block in /etc/hosts, atomically, markers-only
#   3. flush DNS
#   4. start the root AGENT (which is also the TCP forwarder), detached, if it is not
#      already running
#
# Step 4 is what changed in the root-agent model (docs/AGENT.md §1). The agent keeps
# watching desired-state.json after this script exits and redoes steps 1-3 itself whenever
# that file changes, so adding or removing an alias never raises a second prompt. This
# script stays as the explicit manual path for when the agent is NOT running — a reboot, a
# crash, an uninstall — and as the thing that gets it running in the first place.
#
# Nothing is installed. There is no LaunchDaemon, no file outside /etc/hosts, lo0,
# the caller's own config directory and the log directory. See README.md.
#
# Environment (the caller must pass these explicitly: as root under osascript there
# is no useful HOME and no inherited shell):
#   LA_CONFIG_DIR   required, the user's ~/.config/localhost-aliases
#   LA_FORWARDER    required unless --no-forwarder, absolute path to the forwarder
#   LA_HOSTS_PATH   default /etc/hosts
#   LA_LOG_DIR      default $LA_CONFIG_DIR/logs
#   LA_OWNER        optional "uid:gid"; files root creates in the user's dirs are given back
#   LA_MANAGED_IPS  optional space-separated allow-list restricting lo0 removals further
#
# LA_HOSTS_PATH and LA_MANAGED_IPS are also EXPORTED to the agent, so it reconciles against
# the same hosts file and inherits the same "only these addresses are ours" restriction.
#
# Output: exactly one line on stdout, `LA_RESULT status=... key=value ...`.
# Everything else goes to stderr and to $LA_LOG_DIR/privileged.log. On failure the
# last stderr line is `LA_ERROR step=<step> message=<text>`, because `do shell script`
# discards stdout when the exit code is non-zero.

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

# ---------------------------------------------------------------------------
# Arguments and environment
# ---------------------------------------------------------------------------
LA_STEP="arguments"
RESTART_FORWARDER=0
WANT_FORWARDER=1
STATE_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restart-forwarder) RESTART_FORWARDER=1 ;;
    --no-forwarder)      WANT_FORWARDER=0 ;;
    -h|--help)
      printf 'usage: apply.sh [--restart-forwarder] [--no-forwarder] <desired-state.json>\n'
      exit 0 ;;
    --*) la_die "unknown option \"$1\"" ;;
    *)
      [ -z "$STATE_FILE" ] || la_die "expected exactly one desired-state file"
      STATE_FILE="$1" ;;
  esac
  shift
done

[ -n "$STATE_FILE" ] || la_die "usage: apply.sh [--restart-forwarder] [--no-forwarder] <desired-state.json>"
[ -f "$STATE_FILE" ] || la_die "no such desired-state file: ${STATE_FILE}"
[ -n "${LA_CONFIG_DIR:-}" ] || la_die "LA_CONFIG_DIR is not set"
[ -d "$LA_CONFIG_DIR" ] || la_die "LA_CONFIG_DIR does not exist: ${LA_CONFIG_DIR}"

HOSTS_PATH="${LA_HOSTS_PATH:-/etc/hosts}"
LOG_DIR="${LA_LOG_DIR:-${LA_CONFIG_DIR}/logs}"
STATUS_FILE="${LA_CONFIG_DIR}/forwarder-status.json"
ROUTES_FILE="${LA_CONFIG_DIR}/routes.json"

la_open_log "$LOG_DIR"
la_chown_owner "$LOG_DIR"
la_chown_owner "${LOG_DIR}/privileged.log"
la_log "apply.sh starting: state=${STATE_FILE} hosts=${HOSTS_PATH}"
la_require_root

if [ "$WANT_FORWARDER" = "1" ]; then
  [ -n "${LA_FORWARDER:-}" ] || la_die "LA_FORWARDER is not set (or pass --no-forwarder)"
fi

# ---------------------------------------------------------------------------
# Read the desired state. Assume it is hostile: every value is re-validated here,
# whatever the app believes it wrote.
# ---------------------------------------------------------------------------
LA_STEP="desired-state"
MAX_ENTRIES=512

ip_count="$(la_json_array_len "$STATE_FILE" loopbackIps)" || la_die "loopbackIps is missing or not an array"
host_count="$(la_json_array_len "$STATE_FILE" hosts)" || la_die "hosts is missing or not an array"
[[ "$ip_count" =~ ^[0-9]+$ ]] || la_die "loopbackIps has no readable length"
[[ "$host_count" =~ ^[0-9]+$ ]] || la_die "hosts has no readable length"
[ "$ip_count" -le "$MAX_ENTRIES" ] || la_die "loopbackIps has ${ip_count} entries, more than the ${MAX_ENTRIES} allowed"
[ "$host_count" -le "$MAX_ENTRIES" ] || la_die "hosts has ${host_count} entries, more than the ${MAX_ENTRIES} allowed"

WANT_IPS=()
i=0
while [ "$i" -lt "$ip_count" ]; do
  ip="$(la_json_value "$STATE_FILE" "loopbackIps.${i}")" || la_die "could not read loopbackIps.${i}"
  la_is_pool_ip "$ip" \
    || la_die "loopbackIps.${i} is \"${ip}\", which is outside 127.0.0.${LA_POOL_START}-${LA_POOL_END}"
  for existing in ${WANT_IPS[@]+"${WANT_IPS[@]}"}; do
    [ "$existing" = "$ip" ] && la_die "loopbackIps lists ${ip} twice"
  done
  WANT_IPS+=("$ip")
  i=$((i + 1))
done

# One "ip<TAB>hostname" line per managed /etc/hosts entry, in file order.
HOST_LINES=()
HOST_NAMES=()
i=0
while [ "$i" -lt "$host_count" ]; do
  ip="$(la_json_value "$STATE_FILE" "hosts.${i}.ip")" || la_die "could not read hosts.${i}.ip"
  hostname="$(la_json_value "$STATE_FILE" "hosts.${i}.hostname")" || la_die "could not read hosts.${i}.hostname"
  la_is_pool_ip "$ip" \
    || la_die "hosts.${i} points at \"${ip}\", which is outside 127.0.0.${LA_POOL_START}-${LA_POOL_END}"
  la_is_hostname "$hostname" || la_die "hosts.${i} has an invalid hostname \"${hostname}\""
  case "$hostname" in
    localhost|broadcasthost|localhost.*)
      la_die "refusing to manage \"${hostname}\": it belongs to the system part of ${HOSTS_PATH}" ;;
  esac
  for existing in ${HOST_NAMES[@]+"${HOST_NAMES[@]}"}; do
    [ "$existing" = "$hostname" ] && la_die "hosts lists ${hostname} twice"
  done
  found=0
  for existing in ${WANT_IPS[@]+"${WANT_IPS[@]}"}; do
    [ "$existing" = "$ip" ] && found=1
  done
  [ "$found" = "1" ] || la_die "hosts.${i} uses ${ip}, which is not in loopbackIps"
  HOST_NAMES+=("$hostname")
  HOST_LINES+=("${ip}	${hostname}")
  i=$((i + 1))
done
la_log "desired state: ${ip_count} loopback address(es), ${host_count} hosts entry(ies)"

# ---------------------------------------------------------------------------
# 1a. lo0 — add what is missing (before /etc/hosts, so a name never resolves to
#     an address that does not exist yet)
# ---------------------------------------------------------------------------
LA_STEP="lo0"
LIVE_IPS="$(la_lo0_ips || true)"
IPS_ADDED=0
IPS_REMOVED=0

for ip in ${WANT_IPS[@]+"${WANT_IPS[@]}"}; do
  present=0
  for live in $LIVE_IPS; do [ "$live" = "$ip" ] && present=1; done
  if [ "$present" = "0" ]; then
    la_lo0_add "$ip"
    IPS_ADDED=$((IPS_ADDED + 1))
  fi
done

# ---------------------------------------------------------------------------
# 2. /etc/hosts
# ---------------------------------------------------------------------------
LA_STEP="hosts"
BLOCK=""
if [ "${#HOST_LINES[@]}" -gt 0 ]; then
  BLOCK="${LA_BEGIN_MARKER}"$'\n'
  for line in "${HOST_LINES[@]}"; do BLOCK="${BLOCK}${line}"$'\n'; done
  BLOCK="${BLOCK}${LA_END_MARKER}"$'\n'
fi

[ -f "$HOSTS_PATH" ] || la_die "no such file: ${HOSTS_PATH}"
la_hosts_backup "$HOSTS_PATH" "$LA_CONFIG_DIR"
HOSTS_CHANGED=unchanged
if la_hosts_write "$HOSTS_PATH" "$BLOCK"; then HOSTS_CHANGED=changed; fi

# ---------------------------------------------------------------------------
# 1b. lo0 — remove ours that are no longer wanted, now that no hostname points at
#     them. Only pool addresses, never 127.0.0.1, never an address outside
#     LA_MANAGED_IPS when the caller supplied one.
# ---------------------------------------------------------------------------
LA_STEP="lo0"
for live in $LIVE_IPS; do
  la_is_pool_ip "$live" || continue
  wanted=0
  for ip in ${WANT_IPS[@]+"${WANT_IPS[@]}"}; do [ "$ip" = "$live" ] && wanted=1; done
  [ "$wanted" = "1" ] && continue
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
# 3. DNS
# ---------------------------------------------------------------------------
LA_STEP="dns"
la_flush_dns

# ---------------------------------------------------------------------------
# 4. Forwarder
# ---------------------------------------------------------------------------
LA_STEP="forwarder"
FORWARDER_STATE=skipped
FORWARDER_PID=0

if [ "$WANT_FORWARDER" = "1" ]; then
  # The agent inherits nothing from a login shell: as root under osascript there is no
  # useful environment, so everything it needs is exported here, explicitly.
  #   LA_HOSTS_PATH  - it must edit the same file this script just edited
  #   LA_MANAGED_IPS - it must be no freer than this script about what it may remove
  export LA_CONFIG_DIR LA_LOG_DIR="$LOG_DIR" LA_HOSTS_PATH="$HOSTS_PATH"
  if [ -n "${LA_MANAGED_IPS:-}" ]; then export LA_MANAGED_IPS; fi
  running="$(la_forwarder_pid "$STATUS_FILE" "$LA_FORWARDER" || true)"
  ips_changed=0
  [ "$IPS_ADDED" -gt 0 ] && ips_changed=1
  [ "$IPS_REMOVED" -gt 0 ] && ips_changed=1

  if [ -n "$running" ] && { [ "$RESTART_FORWARDER" = "1" ] || [ "$ips_changed" = "1" ]; }; then
    # The set of bindable addresses just changed under it; a restart is the only
    # thing that is guaranteed to leave every route bound.
    la_forwarder_stop "$running"
    running=""
    FORWARDER_STATE=restarted
  fi

  if [ -z "$running" ]; then
    if [ "${#WANT_IPS[@]}" -gt 0 ]; then
      la_forwarder_start "$LA_FORWARDER" "$LOG_DIR"
      FORWARDER_PID="$LA_FORWARDER_PID"
      [ "$FORWARDER_STATE" = "restarted" ] || FORWARDER_STATE=started
    else
      la_log "nothing to forward; not starting the forwarder"
      FORWARDER_STATE=idle
    fi
  else
    FORWARDER_STATE=running
    FORWARDER_PID="$running"
    # It is already up and watching. Nudge both files so a route it could not bind earlier
    # is retried now that lo0 is correct: desired-state.json for the agent, routes.json for
    # a plain forwarder started without reconciliation.
    if [ -f "$STATE_FILE" ]; then touch "$STATE_FILE" 2>/dev/null || true; fi
    if [ -f "$ROUTES_FILE" ]; then touch "$ROUTES_FILE" 2>/dev/null || true; fi
  fi
fi

LA_STEP="done"
la_log "apply.sh finished: +${IPS_ADDED} -${IPS_REMOVED} lo0, hosts ${HOSTS_CHANGED}, forwarder ${FORWARDER_STATE}"
printf 'LA_RESULT status=ok ips_added=%s ips_removed=%s hosts=%s dns=flushed forwarder=%s pid=%s\n' \
  "$IPS_ADDED" "$IPS_REMOVED" "$HOSTS_CHANGED" "$FORWARDER_STATE" "$FORWARDER_PID"
