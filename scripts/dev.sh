#!/usr/bin/env bash
#
# dev.sh — the developer loop. Installs nothing, copies nothing, writes no plist.
#
# It runs the two processes straight out of the working tree:
#   * packages/helper under sudo (root is needed for the control socket in /var/run,
#     for /etc/hosts, and for :80/:443 if you ask for them)
#   * packages/web  as you, via `bun run dev`
#
# Both log streams are prefixed and interleaved on this terminal; Ctrl-C stops both.
# Default ports are 8080/8443 so nothing has to fight over the privileged range —
# use --privileged when you specifically want to test :80/:443.
#
#   ./scripts/dev.sh
#   ./scripts/dev.sh --privileged
#   ./scripts/dev.sh --http 9080 --https 9443 --hosts-file /tmp/hosts-dev

set -euo pipefail

LA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$LA_SCRIPT_DIR/lib.sh"

REPO_ROOT="$(cd -- "$LA_SCRIPT_DIR/.." && pwd -P)"
HELPER_ENTRY="$REPO_ROOT/packages/helper/src/index.ts"
WEB_DIR="$REPO_ROOT/packages/web"

HTTP_PORT=8080
HTTPS_PORT=8443
DASHBOARD_PORT="${LA_DASHBOARD_PORT:-$LA_DASHBOARD_PORT_DEFAULT}"
CONFIG_DIR="${LA_CONFIG_DIR:-}"
HOSTS_FILE_OVERRIDE="${LA_HOSTS_PATH:-}"
RUN_HELPER=1
RUN_WEB=1
FORCE=0

BUN=""
WORKDIR=""
HELPER_PIDFILE=""
HELPER_PID=""
HELPER_SUDO_PID=""
WEB_PID=""
KEEPALIVE_PID=""

usage() {
  cat <<'USAGE'
usage: ./scripts/dev.sh [options]

Runs the helper (sudo) and the dashboard (you) from the working tree. Nothing is
installed; nothing survives Ctrl-C.

Options:
  --http PORT        Helper HTTP listener.  Default 8080.
  --https PORT       Helper HTTPS listener. Default 8443.
  --privileged       Shorthand for --http 80 --https 443.
  --hosts-file PATH  Point the helper at another hosts file (LA_HOSTS_PATH) so your
                     real /etc/hosts is left alone. Recommended while hacking.
  --config-dir DIR   Point both processes at another config dir (LA_CONFIG_DIR).
  --no-helper        Only run the dashboard (no sudo at all).
  --no-web           Only run the helper.
  --force            Run even when the installed LaunchDaemon is loaded (they would
                     fight over the same control socket and ports).
  -h, --help         This text.
USAGE
}

require_port() {
  case "$1" in
    ''|*[!0-9]*) la_die "$2: '$1' is not a port number" ;;
  esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    la_die "$2: $1 is out of range (1-65535)"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --http) [ $# -ge 2 ] || la_die "--http needs a port"; HTTP_PORT="$2"; shift 2 ;;
    --https) [ $# -ge 2 ] || la_die "--https needs a port"; HTTPS_PORT="$2"; shift 2 ;;
    --privileged) HTTP_PORT=80; HTTPS_PORT=443; shift ;;
    --hosts-file) [ $# -ge 2 ] || la_die "--hosts-file needs a path"; HOSTS_FILE_OVERRIDE="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || la_die "--config-dir needs a path"; CONFIG_DIR="$2"; shift 2 ;;
    --no-helper) RUN_HELPER=0; shift ;;
    --no-web) RUN_WEB=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; la_die "unknown option: $1" ;;
  esac
done

require_port "$HTTP_PORT" "--http"
require_port "$HTTPS_PORT" "--https"
if [ "$RUN_HELPER" -eq 0 ] && [ "$RUN_WEB" -eq 0 ]; then
  la_die "--no-helper and --no-web together leave nothing to run"
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
la_require_macos
if [ "$(id -u)" -eq 0 ]; then
  la_die "run dev.sh as yourself. It sudo's only the helper process, on purpose:
  the dashboard must run as you so it writes your config, not root's."
fi

if [ "$RUN_HELPER" -eq 1 ] && [ ! -f "$HELPER_ENTRY" ]; then
  la_die "missing $HELPER_ENTRY (the helper package is not built out yet)"
fi
if [ "$RUN_WEB" -eq 1 ] && [ ! -f "$WEB_DIR/package.json" ]; then
  la_die "missing $WEB_DIR/package.json"
fi

BUN="$(la_find_bun)"

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  la_step "Installing dependencies (bun install)"
  ( cd "$REPO_ROOT" && "$BUN" install )
fi

if [ "$RUN_HELPER" -eq 1 ] && "$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" >/dev/null 2>&1; then
  if [ "$FORCE" -eq 0 ]; then
    la_die "the installed helper daemon is running.
  It already owns $LA_SOCKET_PATH; a second helper would fail to bind it.
  Stop it first:
      sudo launchctl bootout system/$LA_HELPER_LABEL
  and start it again afterwards with:
      sudo launchctl bootstrap system $LA_HELPER_PLIST
  or pass --force if you know what you are doing."
  fi
  la_warn "the installed daemon is loaded and --force was given: expect a bind conflict"
fi

port_in_use() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}
if [ "$RUN_HELPER" -eq 1 ]; then
  for p in "$HTTP_PORT" "$HTTPS_PORT"; do
    if port_in_use "$p"; then
      la_warn "something is already listening on :$p — the helper will fail to bind it"
    fi
  done
fi
if [ "$RUN_WEB" -eq 1 ] && port_in_use "$DASHBOARD_PORT"; then
  la_warn "something is already listening on :$DASHBOARD_PORT (the dashboard port)"
fi

# ---------------------------------------------------------------------------
# Teardown — runs on Ctrl-C, on error, and on normal exit
# ---------------------------------------------------------------------------
alive() { /bin/ps -p "$1" >/dev/null 2>&1; }

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  printf '\n'
  la_step "Shutting down"

  if [ -n "$KEEPALIVE_PID" ] && alive "$KEEPALIVE_PID"; then
    kill "$KEEPALIVE_PID" 2>/dev/null || true
  fi

  if [ -n "$WEB_PID" ] && alive "$WEB_PID"; then
    /usr/bin/pkill -TERM -P "$WEB_PID" 2>/dev/null || true
    kill -TERM "$WEB_PID" 2>/dev/null || true
    la_info "dashboard stopped"
  fi

  if [ -z "$HELPER_PID" ] && [ -n "$HELPER_PIDFILE" ] && [ -s "$HELPER_PIDFILE" ]; then
    HELPER_PID="$(cat "$HELPER_PIDFILE" 2>/dev/null || true)"
  fi
  if [ -n "$HELPER_PID" ] && alive "$HELPER_PID"; then
    # The helper runs as root, so it takes root to signal it. The credential is still
    # fresh because of the keep-alive loop above.
    "$LA_SUDO" -n kill -TERM "$HELPER_PID" 2>/dev/null || "$LA_SUDO" kill -TERM "$HELPER_PID" 2>/dev/null || true
    local i=0
    while [ "$i" -lt 20 ] && alive "$HELPER_PID"; do
      sleep 0.25
      i=$((i + 1))
    done
    if alive "$HELPER_PID"; then
      "$LA_SUDO" -n kill -KILL "$HELPER_PID" 2>/dev/null || true
    fi
    la_info "helper stopped"
  fi
  if [ -n "$HELPER_SUDO_PID" ] && alive "$HELPER_SUDO_PID"; then
    kill -TERM "$HELPER_SUDO_PID" 2>/dev/null || true
  fi

  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Log prefixing: one line at a time, unbuffered, so both streams interleave sanely
# ---------------------------------------------------------------------------
prefix_stream() {
  /usr/bin/awk -v tag="$1" '{ printf "%s %s\n", tag, $0; fflush() }'
}

# ---------------------------------------------------------------------------
# Start the helper
# ---------------------------------------------------------------------------
start_helper() {
  local helper_env=()
  helper_env+=("LA_OWNER_UID=$(id -u)")
  helper_env+=("LA_HTTP_PORT=$HTTP_PORT")
  helper_env+=("LA_HTTPS_PORT=$HTTPS_PORT")
  helper_env+=("LA_DASHBOARD_PORT=$DASHBOARD_PORT")
  helper_env+=("LA_DEV=1")
  helper_env+=("PATH=$(la_launchd_path_for "$(dirname -- "$BUN")")")
  if [ -n "$CONFIG_DIR" ]; then helper_env+=("LA_CONFIG_DIR=$CONFIG_DIR"); fi
  if [ -n "$HOSTS_FILE_OVERRIDE" ]; then helper_env+=("LA_HOSTS_PATH=$HOSTS_FILE_OVERRIDE"); fi

  la_step "helper  root  :$HTTP_PORT (http) :$HTTPS_PORT (https)  socket $LA_SOCKET_PATH"
  if [ -n "$HOSTS_FILE_OVERRIDE" ]; then
    la_info "hosts file: $HOSTS_FILE_OVERRIDE (your real /etc/hosts is untouched)"
  else
    la_warn "the helper will write your real $LA_HOSTS_FILE.
      Use --hosts-file /tmp/hosts-dev to keep it out of the way."
  fi

  # /bin/sh records the pid it is about to become, then exec's through env into bun,
  # so the pidfile holds the *root bun* pid — the only handle we can signal later.
  # shellcheck disable=SC2016,SC2024
  "$LA_SUDO" -n /bin/sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$HELPER_PIDFILE" \
    /usr/bin/env "${helper_env[@]}" "$BUN" run "$HELPER_ENTRY" \
    > >(prefix_stream "${LA_YELLOW}[helper]${LA_OFF}") 2>&1 &
  HELPER_SUDO_PID=$!

  local i=0
  while [ "$i" -lt 40 ]; do
    if [ -s "$HELPER_PIDFILE" ]; then break; fi
    if ! alive "$HELPER_SUDO_PID"; then break; fi
    sleep 0.25
    i=$((i + 1))
  done
  HELPER_PID="$(cat "$HELPER_PIDFILE" 2>/dev/null || true)"
  if [ -z "$HELPER_PID" ]; then
    la_die "the helper did not start (see the [helper] output above)"
  fi
  la_ok "helper pid $HELPER_PID"
}

# ---------------------------------------------------------------------------
# Start the dashboard
# ---------------------------------------------------------------------------
start_web() {
  local web_env=()
  web_env+=("LA_DASHBOARD_PORT=$DASHBOARD_PORT")
  web_env+=("PORT=$DASHBOARD_PORT")
  if [ -n "$CONFIG_DIR" ]; then web_env+=("LA_CONFIG_DIR=$CONFIG_DIR"); fi

  la_step "web     $(id -un)  http://127.0.0.1:$DASHBOARD_PORT"
  ( cd "$WEB_DIR" && exec /usr/bin/env "${web_env[@]}" "$BUN" run dev ) \
    > >(prefix_stream "${LA_BLUE}[web]${LA_OFF}   ") 2>&1 &
  WEB_PID=$!
  la_ok "dashboard pid $WEB_PID"
}

# ---------------------------------------------------------------------------
main() {
  WORKDIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/localhost-aliases-dev.XXXXXX")"
  HELPER_PIDFILE="$WORKDIR/helper.pid"

  if [ "$RUN_HELPER" -eq 1 ]; then
    la_step "Asking for sudo once, up front"
    la_info "root is needed to bind :$HTTP_PORT/:$HTTPS_PORT, create $LA_SOCKET_PATH and write the hosts file"
    if ! "$LA_SUDO" -v -p "[sudo] password for %u (dev helper runs as root): "; then
      la_die "sudo declined — cannot run the helper. Use --no-helper to run only the dashboard."
    fi
    # Keep the credential fresh so teardown can signal the root process without a
    # second password prompt.
    ( while true; do "$LA_SUDO" -n true 2>/dev/null || exit 0; sleep 30; done ) &
    KEEPALIVE_PID=$!
    start_helper
  fi

  if [ "$RUN_WEB" -eq 1 ]; then
    start_web
  fi

  printf '\n%sready%s — Ctrl-C stops everything\n' "$LA_GREEN$LA_BOLD" "$LA_OFF"
  if [ "$RUN_WEB" -eq 1 ]; then
    printf '  dashboard  http://127.0.0.1:%s\n' "$DASHBOARD_PORT"
  fi
  if [ "$RUN_HELPER" -eq 1 ]; then
    printf '  aliases    http://<name>.local:%s\n' "$HTTP_PORT"
    if [ "$HTTP_PORT" != "80" ]; then
      printf '             (dev ports are not 80/443, so the port is part of the URL —\n'
      printf '              run with --privileged for the real thing)\n'
    fi
  fi
  printf '\n'

  # Watch both children: if either one dies, tear the other down instead of leaving
  # half a system running.
  while true; do
    if [ -n "$WEB_PID" ] && ! alive "$WEB_PID"; then
      la_warn "the dashboard exited"
      break
    fi
    if [ -n "$HELPER_PID" ] && ! alive "$HELPER_PID"; then
      la_warn "the helper exited"
      break
    fi
    sleep 1
  done

  # Reaching here means a child died on its own; the EXIT trap stops the other one.
  # Exit non-zero so `./scripts/dev.sh && something` does not carry on.
  return 1
}

main "$@"
