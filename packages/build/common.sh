# Shared helpers for the build scripts. Sourced, never executed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${DIST:-$ROOT/dist}"
APP_NAME="LocalhostAliases"
APP="$DIST/$APP_NAME.app"
BUNDLE_ID="dev.localhost-aliases.app"
TEAM_ID="${TEAM_ID:-UYB68P6HH7}"

step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

app_version() {
  # process.stdout.write, not console.log: Bun's console applies inspect-style ANSI
  # colouring, and those escapes end up inside the captured string.
  bun -e "process.stdout.write((await Bun.file('$ROOT/package.json').json()).version)"
}

# Mach-O files are what codesign cares about; everything else is just payload.
is_macho() { [ -f "$1" ] && file -b "$1" 2>/dev/null | grep -q 'Mach-O'; }

# Every Mach-O in the bundle, deepest path first, so nested code is signed before
# whatever contains it.
list_macho() {
  local root="$1"
  find "$root" -type f -not -path '*/_CodeSignature/*' -print0 \
    | while IFS= read -r -d '' f; do is_macho "$f" && printf '%s\n' "$f"; done \
    | awk '{ print gsub(/\//, "/") "\t" $0 }' | sort -rn -k1,1 | cut -f2-
}

# A TCP port nothing is listening on, above 1024, on the loopback only.
free_port() {
  bun -e '
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const p = s.port; s.stop(true); process.stdout.write(String(p));
  '
}

# Start the bundled dashboard with the embedded Bun and prove it serves a *styled*
# page. `next build --output standalone` omits .next/static, so a missing stylesheet
# is the exact failure this catches. Also doubles as the post-signing smoke test:
# if the entitlements are wrong, Bun dies here instead of on a user's machine.
verify_dashboard() {
  local res="$1"
  local port log pid html css bytes probe_dir
  port="$(free_port)"
  log="$(mktemp -t la-dashboard)"
  # The dashboard writes config/desired-state/routes on boot and reconciles config.dashboardPort
  # to whatever port it bound. Without an isolated config dir a BUILD would overwrite the user's
  # real settings with this throwaway port, and index.local would then forward nowhere.
  probe_dir="$(mktemp -d -t la-verify)"

  PORT="$port" HOSTNAME=127.0.0.1 NODE_ENV=production \
    LA_CONFIG_DIR="$probe_dir" LA_DASHBOARD_PORT="$port" LA_LOG_DIR="$probe_dir/logs" \
    "$res/bin/bun" "$res/dashboard/server.js" >"$log" 2>&1 &
  pid=$!
  # Every exit path below kills exactly this pid, by number. Never pkill/killall by
  # pattern: the user's other dev servers are not ours to touch.
  _stop() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$log"; rm -rf "$probe_dir"; }

  html=""
  local i
  for i in $(seq 1 60); do
    if html="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null)"; then break; fi
    kill -0 "$pid" 2>/dev/null || { cat "$log"; _stop; die "the bundled dashboard exited on startup"; }
    sleep 0.5
  done
  [ -n "$html" ] || { cat "$log"; _stop; die "the bundled dashboard never answered on 127.0.0.1:$port"; }

  css="$(printf '%s' "$html" | grep -o '/_next/static/[^"]*\.css' | head -n1)"
  [ -n "$css" ] || { cat "$log"; _stop; die "the served page links no stylesheet — .next/static was not copied into the bundle"; }
  bytes="$(curl -fsS --max-time 5 "http://127.0.0.1:$port$css" | wc -c | tr -d ' ')"
  [ "$bytes" -gt 500 ] || { _stop; die "$css served $bytes bytes — the stylesheet is missing or empty"; }

  _stop
  info "127.0.0.1:$port served HTML and $css ($bytes bytes)"
}
