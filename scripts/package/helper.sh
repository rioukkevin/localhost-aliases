#!/usr/bin/env bash
#
# helper.sh — compile the privileged helper into a standalone binary and prove it runs.
#
#   scripts/package/helper.sh [--out PATH] [--no-smoke]
#
# The bundle cannot ship TypeScript: `SMAppService.daemon` launches
# Contents/MacOS/la-helper directly, with no bun on PATH and no node_modules anywhere.
# `bun build --compile` welds the sources and the Bun runtime into one Mach-O.
#
# The smoke test is not optional paranoia. A compiled Bun binary resolves imports at build
# time, so anything dynamic (a require built from a variable, a JSON import, a native
# module) can vanish silently and only fail when a *root daemon* starts — the worst place
# to discover it. So we start the real binary here, on temp paths and high ports, and talk
# to its control socket before it is ever allowed near /var/run.

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

OUT="$HELPER_EXECUTABLE"
SMOKE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

BUN="$(find_bun)"
ENTRY="$REPO_ROOT/packages/helper/src/index.ts"
[ -f "$ENTRY" ] || die "missing $ENTRY"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  TARGET="bun-darwin-arm64" ;;
  x86_64) TARGET="bun-darwin-x64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

step "Compiling the helper ($TARGET)"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
# --compile implies --production. Kept minimal on purpose: no --minify, because a stack
# trace from a root daemon has to stay readable in the user's log.
"$BUN" build --compile --target="$TARGET" "$ENTRY" --outfile "$OUT" >/dev/null
chmod 0755 "$OUT"
ok "$OUT ($(human_size "$OUT"))"
info "$(file -b "$OUT")"

[ "$SMOKE" -eq 1 ] || { warn "smoke test skipped"; exit 0; }

# ---------------------------------------------------------------------------
# Smoke test — temp everything, high ports, and only ever our own pid gets killed.
# ---------------------------------------------------------------------------
SMOKE_HTTP="${LA_SMOKE_HTTP_PORT:-18080}"
SMOKE_HTTPS="${LA_SMOKE_HTTPS_PORT:-18443}"
for port in "$SMOKE_HTTP" "$SMOKE_HTTPS"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    die "port $port is already in use; set LA_SMOKE_HTTP_PORT / LA_SMOKE_HTTPS_PORT"
  fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/la-helper-smoke.XXXXXX")"
# sockaddr_un.sun_path is 104 bytes on Darwin; $TMPDIR on macOS is already long, so the
# socket goes straight under /tmp with a short name or bind() fails with ENAMETOOLONG.
SOCK="/tmp/la-sm$$.sock"
HELPER_PID=""

cleanup() {
  if [ -n "$HELPER_PID" ] && kill -0 "$HELPER_PID" 2>/dev/null; then
    kill "$HELPER_PID" 2>/dev/null || true
    wait "$HELPER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  rm -f "$SOCK"
}
trap cleanup EXIT

step "Smoke-testing the compiled binary"
info "socket $SOCK, http :$SMOKE_HTTP, https :$SMOKE_HTTPS, hosts $WORK/hosts"
: >"$WORK/hosts"

env -u LA_OWNER_UID \
  LA_SOCKET_PATH="$SOCK" \
  LA_CONFIG_DIR="$WORK/config" \
  LA_HOSTS_PATH="$WORK/hosts" \
  LA_HTTP_PORT="$SMOKE_HTTP" \
  LA_HTTPS_PORT="$SMOKE_HTTPS" \
  "$OUT" >"$WORK/helper.log" 2>&1 &
HELPER_PID=$!

for _ in $(seq 1 50); do
  [ -S "$SOCK" ] && break
  kill -0 "$HELPER_PID" 2>/dev/null || break
  sleep 0.1
done
if [ ! -S "$SOCK" ]; then
  cat "$WORK/helper.log" >&2
  die "the compiled helper never bound its control socket"
fi
ok "control socket bound (pid $HELPER_PID)"

STATUS="$(curl -fsS --unix-socket "$SOCK" http://localhost/status)" \
  || { cat "$WORK/helper.log" >&2; die "GET /status failed"; }
printf '  %s\n' "$STATUS"
case "$STATUS" in
  *'"ok":true'*) ok "GET /status" ;;
  *) die "unexpected /status payload" ;;
esac

# The proxy half: an unknown Host must reach the branded 404 page. Proves the TCP
# listener, the route table and the inlined HTML all survived compilation.
PROXY="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: nothing.invalid' \
  "http://127.0.0.1:$SMOKE_HTTP/")" || die "the proxy listener refused a connection"
[ "$PROXY" = "404" ] || die "expected 404 from the branded unknown-host page, got $PROXY"
ok "proxy on :$SMOKE_HTTP answers (404 unknown host)"

# Graceful stop through its own API; the trap is only a backstop.
curl -fsS -X POST --unix-socket "$SOCK" http://localhost/shutdown >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  kill -0 "$HELPER_PID" 2>/dev/null || break
  sleep 0.1
done
ok "POST /shutdown stopped it"
