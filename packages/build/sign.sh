#!/usr/bin/env bash
#
# Codesign the bundle, inside out.
#
# Nested code must be signed before whatever contains it, or the outer signature seals a
# hash of unsigned inner code and `codesign --verify --deep` rejects the result.
#
# Entitlements: only com.apple.security.cs.allow-jit, and that one is required.
# Determined empirically, not guessed — see docs at the bottom of this file.
#
# Env: SIGN_IDENTITY (skip discovery), TEAM_ID, LA_ENTITLEMENTS (custom plist),
#      LA_EXTRA_ENTITLEMENTS (space-separated extra keys, all set to <true/>).

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ -d "$APP" ] || die "$APP does not exist — run 'make bundle' first"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"

# --- identity ---------------------------------------------------------------
step "Finding the Developer ID Application identity for team $TEAM_ID"
if [ -z "${SIGN_IDENTITY:-}" ]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep 'Developer ID Application' | grep "$TEAM_ID" \
    | head -n1 | sed -E 's/.*"(.*)".*/\1/' || true)"
fi
if [ -z "$SIGN_IDENTITY" ]; then
  cat >&2 <<MSG
error: no "Developer ID Application" identity for team $TEAM_ID in any unlocked keychain.

  List what you do have:
      security find-identity -v -p codesigning

  If it is missing, download it from https://developer.apple.com/account/resources/certificates
  and double-click the .cer, or export it from another Mac as a .p12 and import it:
      security import DeveloperID.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign

  To sign with a different identity: SIGN_IDENTITY="Developer ID Application: ..." make sign
MSG
  exit 1
fi
info "$SIGN_IDENTITY"

# --- entitlements -----------------------------------------------------------
ENTS="${LA_ENTITLEMENTS:-$DIST/entitlements.plist}"
if [ -z "${LA_ENTITLEMENTS:-}" ]; then
  mkdir -p "$DIST"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo '  <key>com.apple.security.cs.allow-jit</key><true/>'
    for key in ${LA_EXTRA_ENTITLEMENTS:-}; do echo "  <key>$key</key><true/>"; done
    echo '</dict>'
    echo '</plist>'
  } > "$ENTS"
fi
plutil -lint "$ENTS" >/dev/null || die "$ENTS is malformed"
info "entitlements: $(plutil -convert json -o - "$ENTS" | tr -d '{}"' )"

# Only the JavaScript runtimes JIT. The Swift tray does not, and entitlements are not
# inherited by child processes, so it gains nothing from carrying them.
needs_jit() {
  case "$1" in
    "$RES/bin/bun"|"$RES/forwarder"|"$RES/mcp") return 0 ;;
    *) return 1 ;;
  esac
}

# A secure timestamp needs a real certificate; Apple's timestamp server rejects ad-hoc.
# SIGN_IDENTITY="-" is only ever a local smoke test — a release must be timestamped.
TIMESTAMP="--timestamp"
if [ "$SIGN_IDENTITY" = "-" ]; then
  TIMESTAMP="--timestamp=none"
  info "ad-hoc signing: NOT a distributable signature, and not notarizable"
fi

sign_one() {
  local target="$1" label="$2"
  if needs_jit "$target"; then
    codesign --force --sign "$SIGN_IDENTITY" --options runtime "$TIMESTAMP" \
      --entitlements "$ENTS" "$target"
    info "$label  (+allow-jit)"
  else
    codesign --force --sign "$SIGN_IDENTITY" --options runtime "$TIMESTAMP" "$target"
    info "$label"
  fi
}

# --- inside out -------------------------------------------------------------
step "Signing nested code (deepest first)"
COUNT=0
while IFS= read -r macho; do
  [ -n "$macho" ] || continue
  sign_one "$macho" "${macho#"$APP/"}"
  COUNT=$((COUNT + 1))
done < <(list_macho "$APP")
info "$COUNT Mach-O file(s)"

step "Signing the app bundle"
sign_one "$APP" "$(basename "$APP")"

# --- verify -----------------------------------------------------------------
step "codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$APP"

step "Entitlements actually attached"
for b in "$RES/bin/bun" "$RES/forwarder" "$RES/mcp"; do
  [ -f "$b" ] || continue
  printf '    %s: ' "${b#"$APP/"}"
  codesign -d --entitlements - --xml "$b" 2>/dev/null | plutil -convert json -o - - | tr -d '\n'
  printf '\n'
done
codesign -dv "$APP" 2>&1 | grep -E 'Identifier|TeamIdentifier|flags' | sed 's/^/    /'

# --- prove the signature does not break anything ----------------------------
# The whole point of the entitlement question: a signed-but-under-entitled Bun aborts
# with "Ran out of executable memory" the moment it JITs. Run the real thing.
step "Running the signed bundle"
# A real MCP handshake: the reply only exists if the signed binary got through JIT
# compilation. head -n1 closes the pipe, which ends the server.
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sign.sh","version":"1"}}}'
REPLY="$(printf '%s\n' "$INIT" | "$RES/mcp" 2>/dev/null | head -n1 || true)"
printf '%s' "$REPLY" | grep -q '"serverInfo"' \
  || die "the signed mcp binary did not answer an initialize request: ${REPLY:-<no output>}"
info "mcp answered initialize"

# The forwarder is deliberately NOT started here: it binds port 80 on loopback aliases
# and must only ever run as root, from apply.sh. Its signature is verified above.
verify_dashboard "$RES"

step "Gatekeeper (fails until notarized — that is expected here)"
spctl -a -vvv -t exec "$APP" || true

step "Signed: $APP"

# ---------------------------------------------------------------------------
# Why only allow-jit
# ---------------------------------------------------------------------------
# Method: a copy of the embedded Bun and of the bun --compile'd mcp binary were signed
# with --options runtime (hardened runtime enforced; confirmed via `codesign -dv` showing
# flags=...,runtime) under five entitlement sets, then actually run against a workload
# that JITs hard: 2M-iteration loop, recursive fib, WebAssembly instantiation, new
# Function(), a native module import and a child process.
#
#   all three entitlements ........................... runs
#   allow-jit + allow-unsigned-executable-memory ..... runs
#   allow-jit + disable-library-validation ........... runs
#   allow-jit alone .................................. runs
#   no entitlements .................................. dies: "Ran out of executable
#                                                       memory while allocating 128 bytes"
#
# So allow-jit is genuinely required and the other two are not. Dropping them matters:
# allow-unsigned-executable-memory disables the W^X protection that makes allow-jit safe,
# and disable-library-validation would let any unsigned dylib be injected into a process
# that reads the user's projects.
#
# disable-library-validation stays off because every Mach-O in the bundle is signed here
# with the same identity, and Bun itself links only /usr/lib system libraries. If a future
# dashboard dependency ships a third-party .node addon that fails to load with
# "code signature ... not valid for use in process", the fix is to sign it (it is picked up
# automatically by list_macho) — and only if that fails:
#     LA_EXTRA_ENTITLEMENTS=com.apple.security.cs.disable-library-validation make sign
