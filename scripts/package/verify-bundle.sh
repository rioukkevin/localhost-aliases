#!/usr/bin/env bash
#
# verify-bundle.sh — run the assembled bundle's web server and prove it actually serves.
#
#   scripts/package/verify-bundle.sh [--port N] [--app PATH]
#
# It runs the *bundled* pieces the way the tray will — `Contents/Resources/bin/bun`
# executing `Contents/Resources/web/server.js` — and never opens the .app itself.
#
# It answers the three questions a packaging step actually gets wrong:
#   1. does the embedded runtime execute the standalone build at all (traced deps, ESM)?
#   2. does the API work, i.e. did the Bun-native core survive into the bundle?
#   3. did .next/static come along — is the page *styled*? The HTML looks fine either way,
#      so the stylesheet link is extracted from the response and fetched.
#
# Everything is redirected at temp paths: a throwaway LA_CONFIG_DIR, a hosts file in the
# temp directory, a socket path with no helper behind it. It must be impossible for a
# verification run to touch the user's real config, /etc/hosts, or a live helper.

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

PORT="${LA_VERIFY_PORT:-17788}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --app) APP_BUNDLE="$2"; CONTENTS="$APP_BUNDLE/Contents"
           BUN_EXECUTABLE="$CONTENTS/Resources/bin/bun"; WEB_DIR="$CONTENTS/Resources/web"
           WEB_ENTRY="$WEB_DIR/server.js"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -x "$BUN_EXECUTABLE" ] || die "missing $BUN_EXECUTABLE — run scripts/package/bundle.sh first"
[ -f "$WEB_ENTRY" ] || die "missing $WEB_ENTRY — run scripts/package/bundle.sh first"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  die "port $PORT is already in use; pass --port"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/la-verify.XXXXXX")"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step "Booting the bundled dashboard"
info "$BUN_EXECUTABLE $WEB_ENTRY"
info "port $PORT, config $WORK/config, no helper socket"
: >"$WORK/hosts"

# PORT + HOSTNAME are what Next's standalone server.js reads (its default host is 0.0.0.0;
# this dashboard is loopback-only). LA_* are the isolation the safety rules demand.
( cd "$WEB_DIR" && env \
    PORT="$PORT" HOSTNAME=127.0.0.1 NODE_ENV=production \
    LA_DASHBOARD_PORT="$PORT" \
    LA_CONFIG_DIR="$WORK/config" \
    LA_HOSTS_PATH="$WORK/hosts" \
    LA_SOCKET_PATH="$WORK/no-helper.sock" \
    "$BUN_EXECUTABLE" "$WEB_ENTRY" >"$WORK/server.log" 2>&1 ) &
SERVER_PID=$!

for _ in $(seq 1 80); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  sed 's/^/    /' "$WORK/server.log" >&2
  die "the bundled server never became healthy"
fi
ok "pid $SERVER_PID is serving on 127.0.0.1:$PORT"

step "GET /api/health"
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/health")"
printf '  %s\n' "$HEALTH"
case "$HEALTH" in *'"ok":true'*) ok "the Bun-native core runs inside the bundle" ;;
  *) die "unexpected /api/health payload" ;; esac

step "GET / (HTML)"
HTML="$WORK/index.html"
CODE="$(curl -sS -o "$HTML" -w '%{http_code}' "http://127.0.0.1:$PORT/")"
[ "$CODE" = "200" ] || { sed 's/^/    /' "$WORK/server.log" >&2; die "GET / returned $CODE"; }
ok "200, $(wc -c <"$HTML" | tr -d ' ') bytes"
grep -q "<title>" "$HTML" || die "no <title> — that is not a rendered page"

step "Stylesheet"
# The failure this exists for: standalone omits .next/static, so this link 404s and the
# whole UI renders unstyled while every status code above still says 200.
HREF="$(sed -n 's/.*<link rel="stylesheet" href="\([^"]*\)".*/\1/p' "$HTML" | head -1)"
[ -n "$HREF" ] || die "no stylesheet <link> in the HTML"
info "$HREF"
CSS_CODE="$(curl -sS -o "$WORK/app.css" -w '%{http_code}' "http://127.0.0.1:$PORT$HREF")"
CSS_BYTES="$(wc -c <"$WORK/app.css" | tr -d ' ')"
[ "$CSS_CODE" = "200" ] || die "the stylesheet returned $CSS_CODE — .next/static did not make it into the bundle"
[ "$CSS_BYTES" -gt 1000 ] || die "the stylesheet is only $CSS_BYTES bytes"
ok "200, $CSS_BYTES bytes of CSS"
head -c 120 "$WORK/app.css" | sed 's/^/    /'
printf '\n'

step "Result"
ok "the assembled bundle serves a styled dashboard"
