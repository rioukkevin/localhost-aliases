#!/bin/bash
# Shared helpers for the two privileged scripts. Sourced, never executed.
#
# This file MUST be shipped next to apply.sh and uninstall.sh (Resources/privileged/).
# Everything here is written for /bin/bash 3.2 — no mapfile, no associative arrays.
#
# Privileged binaries are resolved to absolute paths, with LA_* overrides that exist
# so the unit tests can point them at logging stubs. See README.md.

# --- /etc/hosts markers. Must stay byte-identical to HOSTS_BEGIN/HOSTS_END in
# --- packages/core/src/types.ts; test/markers.test.ts enforces it.
LA_BEGIN_MARKER='# >>> localhost-aliases >>>'
LA_END_MARKER='# <<< localhost-aliases <<<'

LA_IFCONFIG="${LA_IFCONFIG:-/sbin/ifconfig}"
LA_DSCACHEUTIL="${LA_DSCACHEUTIL:-/usr/bin/dscacheutil}"
LA_KILLALL="${LA_KILLALL:-/usr/bin/killall}"
LA_PLUTIL="${LA_PLUTIL:-/usr/bin/plutil}"
LA_CHOWN="${LA_CHOWN:-/usr/sbin/chown}"

# Loopback pool. 127.0.0.1 is the real loopback and is never ours.
LA_POOL_START=2
LA_POOL_END=254

LA_STEP="startup"
LA_LOGFILE=""

# ---------------------------------------------------------------------------
# Output. stdout carries exactly one machine-readable LA_RESULT line; every
# human-readable byte goes to stderr and, when opened, to the log file.
# ---------------------------------------------------------------------------

la_log() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$line" >&2
  if [ -n "$LA_LOGFILE" ]; then printf '%s\n' "$line" >>"$LA_LOGFILE" 2>/dev/null || true; fi
}

# Last stderr line on failure, and machine-readable: `do shell script` throws away
# stdout when the exit code is non-zero, so the parseable failure lives on stderr.
la_die() {
  local message="$*"
  la_log "FAILED during ${LA_STEP}: ${message}"
  printf 'LA_ERROR step=%s message=%s\n' "$LA_STEP" "$message" >&2
  printf 'LA_RESULT status=error step=%s\n' "$LA_STEP"
  exit 1
}

la_trap_err() {
  local code="$1"
  printf 'LA_ERROR step=%s message=%s\n' "$LA_STEP" "unexpected failure (exit ${code})" >&2
  printf 'LA_RESULT status=error step=%s\n' "$LA_STEP"
  exit "$code"
}

# Root creating the log directory inside the user's own config dir is how
# ~/.config/localhost-aliases/logs/privileged.log ended up root:wheel — and how an
# unprivileged `rm -rf ~/.config/localhost-aliases` later died with "Permission denied",
# taking the rest of the uninstall down with it. Whoever creates a root-owned file owns
# handing it back, so the chown happens HERE, at the point of creation, where it cannot
# be forgotten by a caller.
la_open_log() {
  mkdir -p "$1" 2>/dev/null || true
  if [ -d "$1" ]; then
    LA_LOGFILE="$1/privileged.log"
    : >>"$LA_LOGFILE" 2>/dev/null || LA_LOGFILE=""
  fi
  la_chown_owner "$1"
  [ -n "$LA_LOGFILE" ] && la_chown_owner "$LA_LOGFILE"
  return 0
}

# ---------------------------------------------------------------------------
# Validation. The desired-state JSON is treated as hostile input: nothing reaches
# ifconfig or /etc/hosts before passing these.
# ---------------------------------------------------------------------------

la_is_pool_ip() {
  local ip="$1" last
  [[ "$ip" =~ ^127\.0\.0\.([0-9]{1,3})$ ]] || return 1
  last="${BASH_REMATCH[1]}"
  [ "$last" = "$((10#$last))" ] || return 1   # rejects 127.0.0.02
  [ "$last" -ge "$LA_POOL_START" ] && [ "$last" -le "$LA_POOL_END" ]
}

# The leading regex already excludes glob characters, but the split is made noglob-safe
# here too so the two validators cannot drift apart. See la_is_hostname.
la_is_ipv4() {
  local ip="$1" part ok=1 reglob=0
  [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  case "$-" in *f*) : ;; *) reglob=1; set -f ;; esac
  local IFS='.'
  for part in $ip; do
    [ "$part" = "$((10#$part))" ] || { ok=0; break; }
    [ "$part" -le 255 ] || { ok=0; break; }
  done
  [ "$reglob" = "1" ] && set +f
  [ "$ok" = "1" ]
}

# Mirrors isValidHostname() in packages/core/src/hosts.ts.
#
# `for label in $host` splits on IFS and THEN glob-expands. Without noglob a hostname
# of "*" expands to the filenames in the current directory, and if those all happen to
# look like labels every one of them passes and "*" validates. Splitting must never
# look at the filesystem, so pathname expansion is off for the loop and restored after.
la_is_hostname() {
  local host="$1" label ok=1 reglob=0
  [ -n "$host" ] || return 1
  [ "${#host}" -le 253 ] || return 1
  case "$host" in *[[:space:]]*|*'#'*) return 1 ;; esac
  case "$-" in *f*) : ;; *) reglob=1; set -f ;; esac
  local IFS='.'
  for label in $host; do
    [ -n "$label" ] || { ok=0; break; }
    [ "${#label}" -le 63 ] || { ok=0; break; }
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { ok=0; break; }
  done
  [ "$reglob" = "1" ] && set +f
  [ "$ok" = "1" ]
}

# ---------------------------------------------------------------------------
# JSON. plutil is part of the base system and is a real parser; no hand-rolled
# regex ever sees the state file.
# ---------------------------------------------------------------------------

la_json_array_len() { # <file> <key>
  local head
  head="$("$LA_PLUTIL" -extract "$2" json -o - "$1" 2>/dev/null | head -c 1)" || return 1
  [ "$head" = "[" ] || return 1
  "$LA_PLUTIL" -extract "$2" raw -o - "$1" 2>/dev/null
}

la_json_value() { # <file> <keypath>
  "$LA_PLUTIL" -extract "$2" raw -o - "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# lo0
# ---------------------------------------------------------------------------

# Every IPv4 currently on lo0, ours or not.
la_lo0_ips() {
  "$LA_IFCONFIG" lo0 2>/dev/null | awk '/^[[:space:]]+inet[[:space:]]/ { print $2 }'
}

# Only pool addresses are ever added or removed, and 127.0.0.1 can never reach here.
la_lo0_add() {
  local ip="$1"
  la_is_pool_ip "$ip" || la_die "refusing to add non-pool address \"${ip}\" to lo0"
  la_log "ifconfig lo0 alias ${ip}"
  "$LA_IFCONFIG" lo0 alias "$ip" netmask 255.255.255.255 up \
    || la_die "could not add ${ip} to lo0"
}

la_lo0_remove() {
  local ip="$1"
  la_is_pool_ip "$ip" || la_die "refusing to remove non-pool address \"${ip}\" from lo0"
  la_log "ifconfig lo0 -alias ${ip}"
  "$LA_IFCONFIG" lo0 -alias "$ip" \
    || la_die "could not remove ${ip} from lo0"
}

# ---------------------------------------------------------------------------
# /etc/hosts
# ---------------------------------------------------------------------------

# Rewrite <file> replacing the first managed block with <block> ("" removes it).
# Duplicate blocks collapse into the first; everything outside the markers is
# reproduced verbatim. An unterminated BEGIN runs to EOF, exactly like
# applyBlock() in core, so a half-written file stays recoverable.
la_hosts_rewrite() { # <file> <block>
  LA_BLOCK="$2" LA_BEGIN_M="$LA_BEGIN_MARKER" LA_END_M="$LA_END_MARKER" awk '
    function trim(s) { sub(/\r$/, "", s); sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    BEGIN { blk = ENVIRON["LA_BLOCK"]; bm = ENVIRON["LA_BEGIN_M"]; em = ENVIRON["LA_END_M"]
            inblock = 0; placed = 0 }
    {
      line = trim($0)
      if (inblock) { if (line == em) inblock = 0; next }
      if (line == bm) { inblock = 1; if (!placed) { printf "%s", blk; placed = 1 }; next }
      print
    }
    END { if (!placed && blk != "") printf "%s", blk }
  ' "$1"
}

la_hosts_strip() { la_hosts_rewrite "$1" ""; }

# Atomic: temp file in the same directory, 0644 root:wheel, then rename.
la_hosts_write() { # <file> <block>
  local target="$1" block="$2" dir tmp
  dir="$(dirname "$target")"
  [ -w "$dir" ] || la_die "${dir} is not writable"

  tmp="$(mktemp "${dir}/.localhost-aliases.hosts.XXXXXX")" || la_die "could not create a temp file in ${dir}"
  la_hosts_rewrite "$target" "$block" >"$tmp" || { rm -f "$tmp"; la_die "could not render ${target}"; }

  # Nothing outside the markers may differ. Cheap, and it is the check that turns a
  # bug in the rewrite above into a refusal instead of a mangled /etc/hosts.
  if ! diff -q <(la_hosts_strip "$target") <(la_hosts_strip "$tmp") >/dev/null 2>&1; then
    rm -f "$tmp"
    la_die "refusing to write ${target}: content outside the managed block would change"
  fi
  if [ -s "$target" ] && [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    la_die "refusing to write an empty ${target}"
  fi

  if cmp -s "$target" "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi   # already correct

  chmod 0644 "$tmp" || { rm -f "$tmp"; la_die "could not chmod the temp file"; }
  chown 0:0 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$target" || { rm -f "$tmp"; la_die "could not replace ${target}"; }
  la_log "rewrote ${target}"
  return 0
}

la_hosts_backup() { # <file> <config-dir>
  local target="$1" dest="$2/hosts.original"
  [ -f "$target" ] || return 0
  [ -e "$dest" ] && return 0
  cp -p "$target" "$dest" 2>/dev/null && la_log "kept a first-run copy of ${target} at ${dest}"
  la_chown_owner "$dest"
  return 0
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

la_flush_dns() {
  "$LA_DSCACHEUTIL" -flushcache >/dev/null 2>&1 || la_log "dscacheutil -flushcache failed (continuing)"
  # By exact process name. Never a pattern, and never anything else.
  "$LA_KILLALL" -HUP mDNSResponder >/dev/null 2>&1 || la_log "mDNSResponder was not running (continuing)"
  la_log "flushed DNS"
}

# ---------------------------------------------------------------------------
# Forwarder
# ---------------------------------------------------------------------------

# The pid the forwarder published, but only if that pid is alive AND is really the
# forwarder — a stale status file must never make us signal an unrelated process.
la_forwarder_pid() { # <status-file> <forwarder-path>
  local status="$1" binary="$2" pid cmd
  [ -f "$status" ] || return 1
  pid="$(la_json_value "$status" pid)" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 1 ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$cmd" in *"$binary"*) printf '%s\n' "$pid"; return 0 ;; esac
  return 1
}

# Sets LA_FORWARDER_PID. Deliberately not a command substitution: la_die must be able
# to abort the whole script, and inside `$(...)` it would only kill the subshell.
LA_FORWARDER_PID=""
la_forwarder_start() { # <forwarder> <log-dir>
  local binary="$1" logdir="$2" pid i
  [ -x "$binary" ] || la_die "the forwarder is missing or not executable: ${binary}"
  mkdir -p "$logdir" 2>/dev/null || true
  la_chown_owner "$logdir"

  # Detached WITHOUT nohup. Under `osascript ... with administrator privileges` there is no
  # controlling terminal, and nohup fails outright there:
  #   nohup: can't detach from console: Inappropriate ioctl for device
  # nohup buys nothing anyway once stdout/stderr go to a file and stdin comes from /dev/null —
  # with no controlling terminal there is no SIGHUP to protect against. `disown` drops it from
  # the job table so this shell cannot signal it on exit; the child is reparented to launchd.
  "$binary" >>"${logdir}/forwarder.log" 2>&1 </dev/null &
  pid=$!
  disown "$pid" 2>/dev/null || true

  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      # Surface the real reason instead of just "it exited": the log is the only witness.
      la_log "forwarder log tail: $(tail -n 5 "${logdir}/forwarder.log" 2>/dev/null | tr '\n' ' ')"
      la_die "the forwarder exited immediately; see ${logdir}/forwarder.log"
    fi
    sleep 0.1
  done
  la_log "started the forwarder, pid ${pid}"
  LA_FORWARDER_PID="$pid"
}

la_forwarder_stop() { # <pid>
  local pid="$1" i
  kill -TERM "$pid" 2>/dev/null || return 0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || { la_log "stopped the forwarder, pid ${pid}"; return 0; }
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null || true
  la_log "force-stopped the forwarder, pid ${pid}"
}

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

# Root creates files inside the user's own directories; hand them back.
la_chown_owner() {
  [ -n "${LA_OWNER:-}" ] || return 0
  [[ "$LA_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || return 0
  [ -e "$1" ] || return 0
  "$LA_CHOWN" "$LA_OWNER" "$1" 2>/dev/null || true
  return 0
}

# The same, for a whole directory root has been writing into. This is the last thing the
# privileged half does before it goes away: anything it created must be deletable by the
# user afterwards, because the user is who deletes it.
#
# `chown -R` on BSD does not traverse symlinks (-P is the default), so a link planted inside
# the config directory cannot redirect this at /etc.
la_chown_owner_tree() {
  [ -n "${LA_OWNER:-}" ] || return 0
  [[ "$LA_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || return 0
  local path="${1%/}"
  [ -n "$path" ] || return 0
  # Root walking a whole tree is worth one more guard: LA_CONFIG_DIR arrives from the
  # environment, and `chown -R` over $HOME would be a mess to explain and worse to undo.
  # Mirrors never_ours() in teardown.sh, which refuses the same paths for `rm -rf`.
  case "$path" in
    /|/bin|/sbin|/usr|/etc|/var|/tmp|/opt|/dev|/cores|/Users|/Volumes \
    |/Applications|/Library|/System|/private|/private/tmp|/private/var \
    |"${HOME%/}"|"${HOME%/}"/.config|"${HOME%/}"/Library|"${HOME%/}"/Library/Logs)
      la_log "refusing to chown ${path}: that is never this app's directory"
      return 0 ;;
  esac
  case "${HOME%/}/" in "$path"/*) la_log "refusing to chown ${path}"; return 0 ;; esac
  [ -d "$path" ] || return 0
  "$LA_CHOWN" -R "$LA_OWNER" "$path" 2>/dev/null \
    && la_log "handed ${path} back to ${LA_OWNER}" \
    || la_log "could not chown ${path} to ${LA_OWNER} (continuing)"
  return 0
}

la_require_root() {
  [ "${LA_TEST_MODE:-0}" = "1" ] && return 0
  [ "$(id -u)" = "0" ] || la_die "this script must run as root; the app raises the admin prompt for you"
}
