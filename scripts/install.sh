#!/usr/bin/env bash
#
# install.sh — the single privileged step of localhost-aliases.
#
# It does exactly four things, all of them idempotent (re-running is the supported
# upgrade path, and is also how you recover a broken install):
#
#   1. copies the runtime bundle to /usr/local/lib/localhost-aliases, root-owned 0755
#   2. installs + bootstraps the root LaunchDaemon that owns :80/:443, /etc/hosts and
#      the control socket
#   3. installs + bootstraps the per-user LaunchAgent that runs the dashboard at login
#   4. optionally adds the local CA to the System keychain (--trust-ca)
#
# Run it as yourself: it re-executes itself under sudo, which is how SUDO_USER (and
# therefore LA_OWNER_UID) ends up being your uid instead of 0.
#
#   ./scripts/install.sh [--no-agent] [--trust-ca]
#   ./scripts/install.sh --dry-run
#   ./scripts/install.sh --prefix /tmp/sandbox      # exercise it without touching /
#   ./scripts/install.sh --uninstall [--purge] [--remove-ca]

set -euo pipefail

LA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LA_SELF="$LA_SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. "$LA_SCRIPT_DIR/lib.sh"

REPO_ROOT="$(cd -- "$LA_SCRIPT_DIR/.." && pwd -P)"

WITH_AGENT=1
TRUST_CA=0
BUN=""
DASHBOARD_PORT="${LA_DASHBOARD_PORT:-$LA_DASHBOARD_PORT_DEFAULT}"

usage() {
  cat <<'USAGE'
usage: ./scripts/install.sh [options]

Options:
  --no-agent     Do not install the LaunchAgent. The dashboard will not start at
                 login; run it yourself with `bun run start` in packages/web.
  --trust-ca     Add the local CA (~/.config/localhost-aliases/ca/rootCA.pem) to the
                 System keychain as a trusted root, so https://<alias> is green.
                 Skipped with a notice when the CA has not been generated yet.
  --uninstall    Hand over to ./scripts/uninstall.sh; all remaining flags are passed
                 through (e.g. --purge, --remove-ca).
  --dry-run      Print every command that would change this machine, with all
                 variables expanded, and run none of them. Needs no sudo.
  --prefix DIR   Relocate every system path under DIR (DESTDIR-style): the runtime,
                 both plists, the log dirs, the socket and the home directory mirror.
                 Nothing outside DIR is written. Needs no sudo.
  -h, --help     This text.

Environment:
  LA_USER              Owning user shortname. Defaults to SUDO_USER, then the console owner.
  LA_DASHBOARD_PORT    Port for the dashboard LaunchAgent. Default 7788.
  LA_CONFIG_DIR        Config + CA directory. Passed on to the LaunchAgent when set.
  DESTDIR              Same as --prefix.
USAGE
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --no-agent) WITH_AGENT=0; shift ;;
    --trust-ca) TRUST_CA=1; shift ;;
    --dry-run) LA_DRY_RUN=1; shift ;;
    --prefix) [ $# -ge 2 ] || la_die "--prefix needs a directory"; LA_PREFIX="$2"; shift 2 ;;
    --prefix=*) LA_PREFIX="${1#--prefix=}"; shift ;;
    --uninstall)
      shift
      # LA_DRY_RUN / LA_PREFIX are shell variables, not exported, so they do not survive
      # the exec on their own: `install.sh --dry-run --uninstall` would otherwise run a
      # *real* uninstall. Re-state them as flags.
      if [ -n "$LA_PREFIX" ]; then set -- --prefix "$LA_PREFIX" "$@"; fi
      if [ "$LA_DRY_RUN" = "1" ]; then set -- --dry-run "$@"; fi
      exec "$LA_SCRIPT_DIR/uninstall.sh" "$@"
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; la_die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Privilege
# ---------------------------------------------------------------------------
la_require_macos
la_apply_prefix

REEXEC=("$LA_SELF")
if [ "$WITH_AGENT" -eq 0 ]; then REEXEC+=("--no-agent"); fi
if [ "$TRUST_CA" -eq 1 ]; then REEXEC+=("--trust-ca"); fi
la_reexec_with_sudo "${REEXEC[@]}"

la_require_root
la_resolve_user

HELPER_ENTRY_SRC="$REPO_ROOT/packages/helper/src/index.ts"
HELPER_ENTRY_INSTALLED="$LA_INSTALL_ROOT/packages/helper/src/index.ts"
WEB_DIR_INSTALLED="$LA_INSTALL_ROOT/packages/web"
AGENT_PLIST="$LA_HOME/Library/LaunchAgents/${LA_AGENT_LABEL}.plist"
USER_LOG_DIR="$LA_HOME/Library/Logs/localhost-aliases"
# Mirrors core's configDir(): LA_CONFIG_DIR wins, otherwise ~/.config/localhost-aliases.
# When it is overridden the LaunchAgent has to be told, or the dashboard would read a
# different config than the one --trust-ca just looked in.
CONFIG_DIR="${LA_CONFIG_DIR:-$LA_HOME/.config/localhost-aliases}"
CA_CERT="$CONFIG_DIR/ca/rootCA.pem"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
require_source_file() {
  if [ ! -f "$1" ]; then
    la_die "missing $1
  ($2)
  Install from a complete checkout of the repository."
  fi
}

preflight() {
  la_step "Checking the source tree"
  require_source_file "$REPO_ROOT/package.json" "workspace manifest"
  require_source_file "$REPO_ROOT/packages/core/src/index.ts" "shared core package"
  require_source_file "$HELPER_ENTRY_SRC" "privileged helper entrypoint"
  require_source_file "$REPO_ROOT/packages/web/package.json" "dashboard package"
  la_ok "source tree at $REPO_ROOT"

  # sockaddr_un.sun_path is 104 bytes on Darwin. The production path is nowhere near it,
  # but a --prefix sandbox easily is, and bind() then fails with a puzzling ENAMETOOLONG.
  if [ "${#LA_SOCKET_PATH}" -gt 103 ]; then
    la_die "the control socket path is ${#LA_SOCKET_PATH} bytes:
    $LA_SOCKET_PATH
  A unix socket path cannot exceed 103. Use a shorter --prefix."
  fi

  BUN="$(la_find_bun)"
  la_ok "bun: $BUN"
  case "$BUN" in
    "$LA_HOME"/*)
      la_warn "bun lives under your home directory. The root daemon will still find it,
      but it can fail to start before you log in on a FileVault machine.
      'brew install oven-sh/bun/bun' avoids that."
      ;;
  esac

  if [ ! -d "$REPO_ROOT/node_modules" ]; then
    la_info "node_modules missing — running 'bun install' as $LA_USER"
    ( cd "$REPO_ROOT" && la_run_as_user "$BUN" install )
  fi
  la_ok "dependencies present"

  if [ -f "$REPO_ROOT/packages/web/.next/BUILD_ID" ]; then
    la_ok "dashboard build present"
  elif [ "$WITH_AGENT" -eq 1 ]; then
    la_info "no dashboard build — running 'bun run build' as $LA_USER (this takes a minute)"
    if ! ( cd "$REPO_ROOT/packages/web" && la_run_as_user "$BUN" run build ); then
      la_die "the dashboard build failed.
  Fix it, or re-run with --no-agent to install only the privileged helper."
    fi
    la_ok "dashboard built"
  else
    la_warn "no dashboard build and --no-agent given: installing the helper only.
      Build it later with 'bun run build' and re-run this script."
  fi
}

# ---------------------------------------------------------------------------
# Runtime bundle
# ---------------------------------------------------------------------------
# rsync when available (it is, on every macOS), otherwise ditto. Both end with a
# root-owned tree: rsync -a preserves the source uid, so we chown afterwards.
sync_tree() {
  local src="$1" dst="$2"
  shift 2
  # Guard the rm below: only ever a path inside the install root we control.
  case "${dst%/}" in
    "$LA_INSTALL_ROOT"/?*) ;;
    *) la_die "internal guard: refusing to sync into '$dst' (outside $LA_INSTALL_ROOT)" ;;
  esac
  if [ -n "${RSYNC:-}" ]; then
    la_run "$RSYNC" -a --delete "$@" "$src" "$dst"
  else
    la_run rm -rf "${dst%/}"
    la_run mkdir -p "${dst%/}"
    la_run /usr/bin/ditto "${src%/}" "${dst%/}"
  fi
}

# Bun links workspace packages into node_modules. If those links were absolute they
# would point back at the developer's checkout, so the installed daemon would run
# code the user can edit. Force them relative and inside INSTALL_ROOT.
fix_workspace_links() {
  local pkg link scope="$LA_INSTALL_ROOT/node_modules/@localhost-aliases"
  la_run mkdir -p "$scope"
  for pkg in core helper mcp web; do
    link="$scope/$pkg"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "../../packages/$pkg" ]; then
      continue
    fi
    la_run rm -rf "$link"
    la_run ln -s "../../packages/$pkg" "$link"
  done
  # The workspace has members we do not ship (e2e). rsync copies their links anyway, and
  # a dangling symlink in a root-owned tree is a resolution hazard — drop the strays.
  if [ -d "$scope" ]; then
    for link in "$scope"/*; do
      [ -e "$link" ] || [ -L "$link" ] || continue
      case "$(basename -- "$link")" in
        core|helper|mcp|web) ;;
        *) la_run rm -rf "$link" ;;
      esac
    done
  fi
}

install_runtime() {
  la_step "Installing the runtime into $LA_INSTALL_ROOT"
  RSYNC="$(command -v rsync 2>/dev/null || true)"

  la_run mkdir -p "$LA_INSTALL_ROOT/packages"
  sync_tree "$REPO_ROOT/node_modules/" "$LA_INSTALL_ROOT/node_modules/" \
    --exclude=".cache" --exclude=".DS_Store"

  local pkg
  for pkg in core helper mcp web; do
    sync_tree "$REPO_ROOT/packages/$pkg/" "$LA_INSTALL_ROOT/packages/$pkg/" \
      --exclude=".next/cache" --exclude="node_modules/.cache" \
      --exclude=".DS_Store" --exclude="*.log"
    la_info "packages/$pkg"
  done

  # `install -o/-g` only works as root; in a sandbox run the files are ours already.
  # `${a[@]+"${a[@]}"}` and not `"${a[@]}"`: /bin/bash on a stock Mac is 3.2, where the
  # plain form of an empty array trips `set -u`.
  local own_args=()
  if [ "$(id -u)" -eq 0 ]; then own_args=(-o root -g wheel); fi
  local f
  for f in package.json bun.lock tsconfig.base.json; do
    if [ -f "$REPO_ROOT/$f" ]; then
      la_run /usr/bin/install -m 0644 ${own_args[@]+"${own_args[@]}"} \
        "$REPO_ROOT/$f" "$LA_INSTALL_ROOT/$f"
    fi
  done

  fix_workspace_links

  la_own -R root:wheel "$LA_INSTALL_ROOT"
  la_run chmod 0755 "$LA_INSTALL_ROOT"
  la_run chmod -R go-w "$LA_INSTALL_ROOT"

  if [ "$LA_DRY_RUN" != "1" ] && [ ! -f "$HELPER_ENTRY_INSTALLED" ]; then
    la_die "the helper entrypoint did not make it to $HELPER_ENTRY_INSTALLED"
  fi
  la_ok "runtime installed (root:wheel, group/world read-only)"
}

# ---------------------------------------------------------------------------
# LaunchDaemon (root) — the privileged helper
# ---------------------------------------------------------------------------
write_helper_plist() {
  la_step "Writing $LA_HELPER_PLIST"
  # launchd will not create the log directory for us: a StandardOutPath whose parent is
  # missing makes the job fail to spawn.
  la_run mkdir -p "$LA_DAEMON_LOG_DIR"
  la_own root:wheel "$LA_DAEMON_LOG_DIR"
  la_run chmod 0755 "$LA_DAEMON_LOG_DIR"
  la_run mkdir -p "$(dirname -- "$LA_HELPER_PLIST")"

  local job_path tmp bun_x entry_x root_x log_x sock_x hosts_env=""
  job_path="$(la_launchd_path_for "$(dirname -- "$BUN")")"
  bun_x="$(la_xml_escape "$BUN")"
  entry_x="$(la_xml_escape "$HELPER_ENTRY_INSTALLED")"
  root_x="$(la_xml_escape "$LA_INSTALL_ROOT")"
  log_x="$(la_xml_escape "$LA_DAEMON_LOG_DIR")"
  sock_x="$(la_xml_escape "$LA_SOCKET_PATH")"
  # Only emitted when redirected: the helper's own default is /etc/hosts.
  if [ "$LA_HOSTS_FILE" != "/etc/hosts" ]; then
    hosts_env="
    <key>LA_HOSTS_PATH</key>
    <string>$(la_xml_escape "$LA_HOSTS_FILE")</string>"
  fi

  tmp="$(la_stage_file "$LA_HELPER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LA_HELPER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun_x}</string>
    <string>run</string>
    <string>${entry_x}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root_x}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LA_OWNER_UID</key>
    <string>${LA_UID}</string>
    <key>LA_SOCKET_PATH</key>
    <string>${sock_x}</string>
    <key>PATH</key>
    <string>${job_path}</string>${hosts_env}
  </dict>
  <key>StandardOutPath</key>
  <string>${log_x}/helper.out.log</string>
  <key>StandardErrorPath</key>
  <string>${log_x}/helper.err.log</string>
</dict>
</plist>
PLIST
  )"

  if ! /usr/bin/plutil -lint "$tmp" >/dev/null; then
    rm -f "$tmp"
    la_die "generated an invalid helper plist (this is a bug in install.sh)"
  fi
  la_commit_file "$tmp" "$LA_HELPER_PLIST" 0644 root wheel
  la_ok "LA_OWNER_UID=$LA_UID ($LA_USER), logs in $LA_DAEMON_LOG_DIR"
}

load_daemon() {
  la_step "Bootstrapping system/$LA_HELPER_LABEL"
  local i=0
  if "$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" >/dev/null 2>&1; then
    la_info "already loaded — booting it out first"
    la_run_quiet "$LA_LAUNCHCTL" bootout "system/$LA_HELPER_LABEL" || true
    # bootout is asynchronous: bootstrapping before the old job is really gone
    # fails with "Operation already in progress".
    while [ "$i" -lt 40 ] && [ "$LA_DRY_RUN" != "1" ]; do
      if ! "$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" >/dev/null 2>&1; then break; fi
      sleep 0.25
      i=$((i + 1))
    done
  fi
  # A socket left behind by a killed helper would make bind() fail.
  la_run rm -f "$LA_SOCKET_PATH"

  la_run_quiet "$LA_LAUNCHCTL" enable "system/$LA_HELPER_LABEL" || true
  if ! la_run "$LA_LAUNCHCTL" bootstrap system "$LA_HELPER_PLIST"; then
    la_die "launchctl bootstrap system $LA_HELPER_PLIST failed.
  Check $LA_DAEMON_LOG_DIR/helper.err.log"
  fi
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "then poll for the control socket at $LA_SOCKET_PATH"
    return 0
  fi

  local out state pid
  i=0
  if ! out="$("$LA_LAUNCHCTL" print "system/$LA_HELPER_LABEL" 2>&1)"; then
    la_die "the daemon did not register:
$out"
  fi
  state="$(printf '%s\n' "$out" | /usr/bin/awk -F'= ' '/^[[:space:]]*state = /{print $2; exit}')"
  pid="$(printf '%s\n' "$out" | /usr/bin/awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}')"
  la_ok "state=${state:-unknown}${pid:+ pid=$pid}"

  while [ "$i" -lt 40 ]; do
    if [ -S "$LA_SOCKET_PATH" ]; then break; fi
    sleep 0.25
    i=$((i + 1))
  done
  if [ -S "$LA_SOCKET_PATH" ]; then
    la_ok "control socket $LA_SOCKET_PATH is up"
  else
    la_warn "no control socket at $LA_SOCKET_PATH after 10s.
      The daemon is registered but may be crash-looping. Look at
      $LA_DAEMON_LOG_DIR/helper.err.log"
  fi
}

# ---------------------------------------------------------------------------
# LaunchAgent (the human) — the dashboard / API server
# ---------------------------------------------------------------------------
write_agent_plist() {
  la_step "Writing $AGENT_PLIST"
  local job_path tmp bun_x web_x home_x log_x config_env=""
  job_path="$(la_launchd_path_for "$(dirname -- "$BUN")")"
  bun_x="$(la_xml_escape "$BUN")"
  web_x="$(la_xml_escape "$WEB_DIR_INSTALLED")"
  home_x="$(la_xml_escape "$LA_HOME")"
  log_x="$(la_xml_escape "$USER_LOG_DIR")"
  if [ -n "${LA_CONFIG_DIR:-}" ]; then
    config_env="
    <key>LA_CONFIG_DIR</key>
    <string>$(la_xml_escape "$CONFIG_DIR")</string>"
  fi

  local own_args=()
  if [ "$(id -u)" -eq 0 ]; then own_args=(-o "$LA_USER" -g "$LA_GROUP"); fi
  la_run /usr/bin/install -d ${own_args[@]+"${own_args[@]}"} -m 0755 "$LA_HOME/Library/LaunchAgents"
  la_run /usr/bin/install -d ${own_args[@]+"${own_args[@]}"} -m 0755 "$USER_LOG_DIR"

  tmp="$(la_stage_file "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LA_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun_x}</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${web_x}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home_x}</string>
    <key>PATH</key>
    <string>${job_path}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>LA_DASHBOARD_PORT</key>
    <string>${DASHBOARD_PORT}</string>
    <key>PORT</key>
    <string>${DASHBOARD_PORT}</string>${config_env}
  </dict>
  <key>StandardOutPath</key>
  <string>${log_x}/web.out.log</string>
  <key>StandardErrorPath</key>
  <string>${log_x}/web.err.log</string>
</dict>
</plist>
PLIST
  )"

  if ! /usr/bin/plutil -lint "$tmp" >/dev/null; then
    rm -f "$tmp"
    la_die "generated an invalid agent plist (this is a bug in install.sh)"
  fi
  la_commit_file "$tmp" "$AGENT_PLIST" 0644 "$LA_USER" "$LA_GROUP"
  la_ok "owned by $LA_USER, logs in $USER_LOG_DIR"
}

load_agent() {
  la_step "Bootstrapping gui/$LA_UID/$LA_AGENT_LABEL"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_dry "$LA_LAUNCHCTL bootout gui/$LA_UID/$LA_AGENT_LABEL   (if already loaded)"
    la_dry "$LA_LAUNCHCTL enable gui/$LA_UID/$LA_AGENT_LABEL"
    la_dry "$LA_LAUNCHCTL bootstrap gui/$LA_UID $AGENT_PLIST"
    return 0
  fi
  if ! "$LA_LAUNCHCTL" print "gui/$LA_UID" >/dev/null 2>&1; then
    la_warn "no GUI session for $LA_USER right now.
      The plist is installed, so the dashboard starts at your next login."
    return 0
  fi
  local i=0
  if la_user_launchctl print "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1; then
    la_user_launchctl bootout "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1 || true
    while [ "$i" -lt 40 ]; do
      if ! la_user_launchctl print "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1; then break; fi
      sleep 0.25
      i=$((i + 1))
    done
  fi
  la_user_launchctl enable "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1 || true
  if ! la_user_launchctl bootstrap "gui/$LA_UID" "$AGENT_PLIST"; then
    la_warn "could not bootstrap the agent now; it will start at your next login."
    return 0
  fi
  if la_user_launchctl print "gui/$LA_UID/$LA_AGENT_LABEL" >/dev/null 2>&1; then
    la_ok "dashboard agent running (launch at login enabled)"
  else
    la_warn "the agent did not register; check $USER_LOG_DIR/web.err.log"
  fi
}

# ---------------------------------------------------------------------------
# Local CA
# ---------------------------------------------------------------------------
trust_ca() {
  la_step "Trusting the local CA"
  if [ ! -f "$CA_CERT" ]; then
    la_warn "no CA at $CA_CERT.
      It is generated the first time you enable HTTPS in the dashboard.
      Do that, then re-run: sudo $LA_SELF --trust-ca"
    return 0
  fi
  if la_run_quiet "$LA_SECURITY" add-trusted-cert -d -r trustRoot \
       -k "$LA_SYSTEM_KEYCHAIN" "$CA_CERT"; then
    la_ok "'$LA_CA_COMMON_NAME' is a trusted root in the System keychain"
  else
    la_warn "could not add the CA automatically. Run it by hand:
      sudo security add-trusted-cert -d -r trustRoot -k $LA_SYSTEM_KEYCHAIN $CA_CERT"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
summary() {
  local agent_line="not installed (--no-agent)"
  if [ "$WITH_AGENT" -eq 1 ]; then agent_line="$AGENT_PLIST"; fi

  printf '\n%s%sInstalled.%s\n\n' "$LA_BOLD" "$LA_GREEN" "$LA_OFF"
  printf '  runtime        %s  (root:wheel, 0755)\n' "$LA_INSTALL_ROOT"
  printf '  helper daemon  %s\n' "$LA_HELPER_PLIST"
  printf '                 runs as root, LA_OWNER_UID=%s (%s)\n' "$LA_UID" "$LA_USER"
  if [ -S "$LA_SOCKET_PATH" ]; then
    printf '  control socket %s  (owned by %s, mode 0600)\n' "$LA_SOCKET_PATH" "$LA_USER"
  else
    printf '  control socket %s  %s(not up yet — check the daemon log)%s\n' \
      "$LA_SOCKET_PATH" "$LA_YELLOW" "$LA_OFF"
  fi
  printf '  daemon logs    %s/helper.{out,err}.log\n' "$LA_DAEMON_LOG_DIR"
  printf '  web agent      %s\n' "$agent_line"
  if [ "$WITH_AGENT" -eq 1 ]; then
    printf '  web logs       %s/web.{out,err}.log\n' "$USER_LOG_DIR"
  fi
  printf '\n  Dashboard:     %shttp://127.0.0.1:%s%s\n' "$LA_BOLD" "$DASHBOARD_PORT" "$LA_OFF"
  printf '\n  Status:        launchctl print system/%s\n' "$LA_HELPER_LABEL"
  printf '  Logs:          tail -f %s/helper.err.log\n' "$LA_DAEMON_LOG_DIR"
  printf '  Uninstall:     sudo %s/uninstall.sh\n\n' "$LA_SCRIPT_DIR"
}

# ---------------------------------------------------------------------------
main() {
  la_say "${LA_BOLD}localhost-aliases installer${LA_OFF} — user ${LA_USER} (uid ${LA_UID})"
  if [ "$LA_DRY_RUN" = "1" ]; then
    la_warn "--dry-run: nothing below is executed"
  fi
  preflight
  install_runtime
  write_helper_plist
  load_daemon
  if [ "$WITH_AGENT" -eq 1 ]; then
    write_agent_plist
    load_agent
  else
    la_step "Skipping the LaunchAgent (--no-agent)"
    la_info "start the dashboard yourself: cd $WEB_DIR_INSTALLED && bun run start"
  fi
  if [ "$TRUST_CA" -eq 1 ]; then
    trust_ca
  fi
  summary
}

main "$@"
