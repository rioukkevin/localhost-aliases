# What runs as root, and why

You are about to be asked for your password. This document is the whole truth about
what happens when you type it. Everything below is in this folder; read it.

There is **no installer, no background service, no LaunchDaemon and no helper tool**.
Nothing of ours is left running with privileges after the app quits, and nothing of ours
survives a reboot except two lines of text you can delete by hand.

## Why root is needed at all

A name like `myapp.local` has to resolve, and something has to answer on port 80.

| What we need | Why it needs root |
|---|---|
| A line in `/etc/hosts` | The file is owned by root. This is the only way to name a host on a Mac without running a DNS server. |
| An extra loopback address, e.g. `127.0.0.2` | Configuring a network interface is privileged. Each alias gets its own address so each can own port 80. |
| Listening on port 80 | Ports below 1024 are reserved for root on macOS. |
| Flushing the DNS cache | The resolver cache is system-wide. |

That is the entire list. If any of it were possible unprivileged, we would do it that way.

## The one prompt

`prompt.ts` raises **one** macOS admin dialog with `osascript … with administrator
privileges`, and it runs exactly one command: `/bin/bash apply.sh <desired-state.json>`.
Nothing is elevated at any other moment. If you cancel, the result is a normal
"cancelled" and nothing at all has happened.

The command is built by quoting every argument for `/bin/sh` and then escaping the whole
string for AppleScript, so a folder named `My "Projects"` or `$(whoami)` is data, never
code. That escaping is the most heavily tested code in this package.

## What `apply.sh` does, in order

It reads a JSON file (the *desired state*) that the app wrote in your own config
directory, and does four things. It is idempotent — running it twice changes nothing the
second time.

1. **`ifconfig lo0 alias <ip>`** for each address the aliases need, and
   **`ifconfig lo0 -alias <ip>`** for each of ours that is no longer wanted.
   Only `127.0.0.2` … `127.0.0.254` are ever touched. `127.0.0.1` is refused by an
   explicit check, and so is every address outside that range — including on the removal
   side, so an address some other tool put on `lo0` is left alone. Pass `LA_MANAGED_IPS`
   to narrow removals further to the exact set this install allocated.
   These are not persisted anywhere: a reboot clears them, which is why the app asks
   again after a restart.

2. **Rewrites the managed block in `/etc/hosts`**, which is the text between

   ```
   # >>> localhost-aliases >>>
   127.0.0.2	index.local
   # <<< localhost-aliases <<<
   ```

   Everything outside those two markers is copied through byte for byte, and the script
   *verifies* that before it writes: it diffs the old and new file with the block removed
   from both, and refuses to write if a single byte outside the markers would change. The
   new file is written to a temp file in `/etc`, `chmod 0644`, `chown root:wheel`, and
   then renamed over `/etc/hosts` — a rename is atomic, so there is no moment where the
   file is half-written. The first time it runs, it copies your original `/etc/hosts` to
   `~/.config/localhost-aliases/hosts.original`.

   Every hostname is re-validated here, in the root script, against the same rules the
   app uses: lowercase letters, digits and hyphens only, no whitespace, no `#`, and every
   address must be inside the loopback pool. `localhost` and `broadcasthost` are refused
   outright. A corrupted or hostile state file cannot make this script point a name at an
   address off your machine, add a second line, or write anything it did not parse.

3. **`dscacheutil -flushcache` and `killall -HUP mDNSResponder`** — the standard macOS
   pair, so a name you just added resolves immediately. `killall` is used with an exact
   process name, never a pattern.

4. **Starts the forwarder** as root, detached, with its output appended to
   `~/Library/Logs/localhost-aliases/forwarder.log`, if it is not already running. It is
   started only when there is something to forward, and only after `lo0` is correct.

Then it prints one line, e.g.

```
LA_RESULT status=ok ips_added=1 ips_removed=0 hosts=changed dns=flushed forwarder=started pid=4242
```

On failure it exits non-zero and the last line on stderr is
`LA_ERROR step=<step> message=<what went wrong>`. Every run also appends to
`~/Library/Logs/localhost-aliases/privileged.log`, so you can read afterwards exactly
what was done.

## The forwarder, and how a root process is stopped without root

The forwarder is the only thing of ours that keeps running as root, and it exists only to
splice raw bytes from `<loopback-ip>:80` to `127.0.0.1:<your dev server port>`. It does
not parse HTTP, does not read your traffic and cannot terminate TLS — which is exactly
why WebSockets and any other protocol pass through untouched, and why project aliases are
`http://` only.

A process you own cannot kill a root process, so the forwarder is not killed: it watches a
heartbeat file that the app touches every few seconds, and **exits on its own** when that
file goes stale. Quitting the app therefore stops it, with no second password prompt.
`uninstall.sh` deletes the heartbeat file too, so the forwarder stops even in the case
where it cannot be signalled.

## What is never touched

- Nothing in `/Library`, `/System`, `/Applications`, `/usr` or `/var`.
- No LaunchDaemon, LaunchAgent, `SMAppService`, kernel extension or privileged helper.
- No file in `/etc` other than `/etc/hosts`, and inside it, no byte outside our markers.
- No loopback address outside `127.0.0.2`–`127.0.0.254`, and never `127.0.0.1`.
- No process is signalled except a pid the forwarder itself published *and* that is still
  running *and* whose command line is still the forwarder's own path. Nothing is ever
  matched by name or pattern.
- Your keychain, your shell profile, your git config, your network settings: untouched.

## Undoing everything

`uninstall.sh` reverses all of it in one pass, behind the same single prompt: stop the
forwarder, remove our `lo0` addresses, strip the managed block out of `/etc/hosts`, flush
DNS. It deletes the forwarder's status and heartbeat files, and nothing else — not your
config, not your original-hosts copy, not the app.

By hand, without this project, it is:

```sh
sudo ifconfig lo0 -alias 127.0.0.2          # for each address you see in your hosts block
sudo nano /etc/hosts                        # delete the block between the two markers
sudo dscacheutil -flushcache
```

## Verifying it yourself

```sh
ifconfig lo0                                  # which addresses exist
cat /etc/hosts                                # what we wrote, between the markers
cat ~/Library/Logs/localhost-aliases/privileged.log   # what every run did
cat ~/.config/localhost-aliases/desired-state.json    # what the app asked for
```

## Files

| File | Runs as | What it is |
|---|---|---|
| `apply.sh` | root | The single privileged entrypoint. |
| `uninstall.sh` | root | The exact reverse. |
| `lib.sh` | root | Shared helpers: validation, the `/etc/hosts` transform, `lo0`, DNS, the forwarder. **Must be shipped in the same directory as the two scripts**; they refuse to run without it. |
| `prompt.ts` | you | The `osascript` wrapper. The only place a password is ever requested. |

## Environment contract

The scripts inherit nothing useful — as root under `osascript` there is no meaningful
`HOME` — so the caller passes everything explicitly. `privilegedEnv()` in `prompt.ts`
builds this:

| Variable | Required | Meaning |
|---|---|---|
| `LA_CONFIG_DIR` | yes | Your `~/.config/localhost-aliases`. |
| `LA_FORWARDER` | yes, unless `--no-forwarder` | Absolute path to the forwarder binary. |
| `LA_HOSTS_PATH` | no (`/etc/hosts`) | The hosts file to edit. |
| `LA_LOG_DIR` | no (`$LA_CONFIG_DIR/logs`) | Where the logs go. |
| `LA_OWNER` | no | `uid:gid`; files root creates in your directories are handed back to you. |
| `LA_MANAGED_IPS` | no | Space-separated allow-list narrowing which `lo0` addresses may be removed. |

`LA_IFCONFIG`, `LA_DSCACHEUTIL`, `LA_KILLALL`, `LA_PLUTIL` and `LA_TEST_MODE` exist so the
unit tests can drive the scripts against stubs and a temp hosts file. They default to the
absolute system paths, and the tests are the only thing that ever sets them: no test may
touch the real `/etc/hosts`, the real `lo0` or run a real privileged command.
