# What runs as root, and why

You are about to be asked for your password. This document is the whole truth about
what happens when you type it. Everything below is in this folder; read it.

There is **no installer, no LaunchDaemon, no `SMAppService` and no helper tool**. Nothing
of ours is left running with privileges after the app quits, and nothing of ours survives a
reboot except two lines of text you can delete by hand.

There *is* one long-lived root process while the app is open — the **agent** — and it acts
on a file you can write. That is the whole reason you are only asked for your password once
instead of on every edit, and it is a genuine tradeoff: ["The root agent, and the privilege
escalation it buys"](#the-root-agent-and-the-privilege-escalation-it-buys) spells it out.

## Why root is needed at all

A name like `myapp.test` has to resolve, and something has to answer on port 80.

| What we need | Why it needs root |
|---|---|
| A line in `/etc/hosts` | The file is owned by root. This is the only way to name a host on a Mac without running a DNS server. |
| An extra loopback address, e.g. `127.0.0.2` | Configuring a network interface is privileged. Each alias gets its own address so each can own port 80. |
| Listening on port 80 | Ports below 1024 are reserved for root on macOS. |
| Flushing the DNS cache | The resolver cache is system-wide. |

That is the entire list. If any of it were possible unprivileged, we would do it that way.

## The one prompt — once, at app launch

`prompt.ts` raises **one** macOS admin dialog with `osascript … with administrator
privileges`, and it runs exactly one command: `/bin/bash apply.sh <desired-state.json>`.
Nothing is elevated at any other moment. If you cancel, the result is a normal
"cancelled" and nothing at all has happened.

It used to be one prompt **per change**. Adding five aliases meant typing your password
five times, which is not a security boundary anyone actually reads — it is a box you
learn to dismiss. So the last thing `apply.sh` does is start a long-lived root process,
the **agent**, and after that adding, renaming, re-porting or deleting an alias raises
nothing at all. Read the next section before you decide you are happy with that.

If you cancel the launch prompt, nothing is running as root and your aliases will not
resolve. The menu-bar item then reads **"Start the Root Agent…"** and is the explicit way
to ask for the prompt again; on the command line it is `prompt.ts apply`. Nothing
re-raises a dialog you dismissed.

The command is built by quoting every argument for `/bin/sh` and then escaping the whole
string for AppleScript, so a folder named `My "Projects"` or `$(whoami)` is data, never
code. That escaping is the most heavily tested code in this package.

## The root agent, and the privilege escalation it buys

The agent is the same process as the forwarder — one root process, not two. As well as
splicing bytes it **watches `~/.config/localhost-aliases/desired-state.json`** and, when
that file changes, redoes steps 1–3 below by itself: the `lo0` addresses, the managed
`/etc/hosts` block, the DNS flush, and which ports it forwards. No prompt.

**Say it plainly: that file is writable by you, and a root process acts on it.** Any
program running as your user can therefore edit `desired-state.json` and have root add a
loopback address and write a line into `/etc/hosts` on its behalf. That is a real local
privilege escalation. It is the price of not asking for your password on every edit, and
you should know you are paying it.

What it is *not* is a way to run arbitrary code as root. The agent never executes anything
the file names, and it re-validates every field itself on every read — it does not trust
the file for having been written by our own dashboard:

- **hostnames** go through the same rules the app uses: lowercase letters, digits and
  hyphens, no whitespace, no `#`, no newline, no over-long label. `localhost`,
  `broadcasthost`, `local` and anything ending in `.localhost` are refused, so the system's
  own names cannot be captured.
- **addresses** must be inside `127.0.0.2`–`127.0.0.254`. `127.0.0.1` fails that test, so
  it can never be added, and never removed. An address the agent did not allocate is never
  removed either, so a `127.0.0.9` you set up for something else survives.
- **`/etc/hosts`** is only ever edited between the markers, written atomically, and the
  write is refused outright if a single byte outside the markers would change.
- **forward targets** must be loopback, so a route can never publish your dev server onto
  the network.
- One bad entry rejects the **whole file** and the previous state stands, with the reason
  written to `~/Library/Logs/localhost-aliases/forwarder.log`. A truncated write can
  therefore never read as "remove everything".

So the worst a hostile local program can do through this channel is give itself a
`something.test` name pointing at a loopback address on your own machine — which it could
also get by asking you for your password once, because it is running as you and can raise
the same dialog we do. If you would rather not have that, quit the app: nothing runs as
root once it is gone, and the agent is not restarted at login unless you turn that on.

The agent stops on its own — see "how a root process is stopped without root" below.

## What `apply.sh` does, in order

It reads a JSON file (the *desired state*) that the app wrote in your own config
directory, and does four things. It is idempotent — running it twice changes nothing the
second time. Steps 1–3 are the same three the agent then keeps redoing on its own; this
script is what performs them the first time, and the explicit manual path for when the
agent is not running (after a reboot, a crash, or a cancelled prompt).

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
   127.0.0.2	index.test
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

4. **Starts the agent** (which is also the forwarder) as root, detached, with its output
   appended to `~/Library/Logs/localhost-aliases/forwarder.log`, if it is not already
   running. It is started only when there is something to forward, and only after `lo0` is
   correct. `LA_CONFIG_DIR`, `LA_HOSTS_PATH` and `LA_MANAGED_IPS` are exported to it
   explicitly, so it reconciles against the same hosts file and is no freer than this
   script about which addresses it may remove.

   If the agent is *already* up, this script does not start a second one: it touches
   `desired-state.json` and `routes.json` so the running agent re-reads them, and reports
   `forwarder=running`.

Then it prints one line, e.g.

```
LA_RESULT status=ok ips_added=1 ips_removed=0 hosts=changed dns=flushed forwarder=started pid=4242
```

On failure it exits non-zero and the last line on stderr is
`LA_ERROR step=<step> message=<what went wrong>`. Every run also appends to
`~/Library/Logs/localhost-aliases/privileged.log`, so you can read afterwards exactly
what was done.

## The agent, and how a root process is stopped without root

The agent is the only thing of ours that keeps running as root. Most of what it does is
splice raw bytes from `<loopback-ip>:80` to `127.0.0.1:<your dev server port>`. It does
not parse HTTP, does not read your traffic and cannot terminate TLS — which is exactly
why WebSockets and any other protocol pass through untouched, and why project aliases are
`http://` only.

There is exactly one exception, and only on the failure path: when your dev server is
**not** listening, the connection has nowhere to go, so the agent looks at the first few
bytes the client sent. If they begin with an HTTP method it answers a self-contained
`503` page saying which alias you are on and which port is dead. If they do not, it closes
without writing a byte — inventing an HTTP response for a protocol we do not speak would
corrupt it. A working connection is never inspected.

A process you own cannot kill a root process, so the agent is not killed: it watches a
heartbeat file that the app touches every few seconds, and **exits on its own** when that
file goes stale (about 15 seconds). Quitting the app therefore stops it, with no second
password prompt, and nothing of ours is left running as root. `uninstall.sh` deletes the
heartbeat file too, so it stops even in the case where it cannot be signalled.

## What is never touched

- Nothing in `/Library`, `/System`, `/Applications`, `/usr` or `/var`.
- No LaunchDaemon, LaunchAgent, `SMAppService`, kernel extension or privileged helper.
- No file in `/etc` other than `/etc/hosts`, and inside it, no byte outside our markers.
- No loopback address outside `127.0.0.2`–`127.0.0.254`, and never `127.0.0.1`.
- No process is signalled except a pid the forwarder itself published *and* that is still
  running *and* whose command line is still the forwarder's own path. Nothing is ever
  matched by name or pattern.
- Your keychain, your shell profile, your git config, your network settings: untouched.
- Nothing named in `desired-state.json` is ever executed. The agent has four verbs —
  add an address, remove an address, rewrite the hosts block, flush DNS — and no
  "run this for me" escape hatch.

## Undoing everything

`teardown.sh` is the whole uninstall, and it is shipped inside the app — which is the point:
removing this app must not require a copy of its source code. `make uninstall` runs the same
file. It is **not** privileged; it raises the one prompt for the one step that needs root, and
does the rest as you:

1. **`uninstall.sh` as root** (the single prompt): stop the agent, remove our `lo0`
   addresses, strip the managed block out of `/etc/hosts`, flush DNS, and hand back every file
   root created in your own directories.
2. the local CA in your **login keychain**, matched by SHA-1 fingerprint — never by name,
   because deleting the wrong certificate is unrecoverable;
3. `~/.config/localhost-aliases`;
4. `~/Library/Logs/localhost-aliases`;
5. the `.app` itself, through `self-delete.sh`.

**Every step reports and continues.** A step that fails is named in the report and the steps
after it still run. That is not a preference: a run that stopped at step 3 on a root-owned
`logs/privileged.log` left a user with an app that had already dismantled its own system state
and could no longer remove itself. The one thing that does stop the sequence is *cancelling*
the password prompt, which removes nothing at all.

Step 1 is why `LA_OWNER` matters. Root writes `logs/privileged.log` inside your config
directory; without being told who you are it leaves that file `root:wheel` and step 3 cannot
delete it. `uninstall.sh` now chowns what it creates as it creates it, and sweeps the whole
config and log directory back to you before it gives up root.

`self-delete.sh` exists because a running app cannot reliably delete its own bundle. It is
copied to a scratch directory *outside* the bundle, spawned detached, waits for the app's pid
to exit, and then removes the bundle. It refuses any path that is not our bundle: absolute, no
`..`, named `LocalhostAliases.app`, containing `Contents/MacOS/LocalhostAliases`, and with our
bundle id in its `Info.plist`. `/Applications` and `~/Applications` both satisfy that; nothing
else does by accident. The wait is bounded, so it never lingers.

Steps 3 and 4 apply the same suspicion to the directories they delete. `LA_CONFIG_DIR` and
`LA_LOG_DIR` are honoured all the way down — `paths.ts` reads them, `Paths.swift` mirrors them,
`make uninstall` asks `paths.ts` — so a stale `export LA_CONFIG_DIR=…` in a shell would pick
the argument to `rm -rf`. `never_ours()` refuses `/`, the system directories, `$HOME`, anything
containing `$HOME`, and the obvious homes of other people's data (`~/.config`, `~/Library`,
`~/Library/Logs`, `~/Desktop`, …). Everything *below* those is still fair game, which is why
`~/.config/localhost-aliases` is removed and `~/.config` is not. A refusal is a failed step, so
the app is still removed afterwards.

`make uninstall` also asks whether anything is installed at all before it runs any of this: the
app, `~/.config/localhost-aliases`, the log directory, the managed `/etc/hosts` block, and any
`127.0.0.2-254` on `lo0`. All five are readable without root. If none of them is there it says
"nothing to uninstall" and stops — no password prompt, no deletions. It used to prompt, revert
nothing, and delete the log directory anyway.

Run `teardown.sh --dry-run` to print every command it would run, fully expanded, and execute
none of them. `make uninstall` removes `dist/` afterwards — a build artifact of your checkout,
not something `teardown.sh` knows about — but not after a dry run and not after a cancelled
prompt, because those removed nothing.

`uninstall.sh` on its own still deletes nothing outside the system state — not your config,
not your original-hosts copy, not the app. Those belong to you, and none of them needs root.

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
cat ~/Library/Logs/localhost-aliases/forwarder.log    # every reconcile the agent did, and every one it refused
ps -o user=,command= -p "$(plutil -extract pid raw ~/.config/localhost-aliases/forwarder-status.json 2>/dev/null)"
```

The last line is the honest check: it prints the one root process, or nothing at all.

## Files

| File | Runs as | What it is |
|---|---|---|
| `apply.sh` | root | The single privileged entrypoint. |
| `uninstall.sh` | root | The exact reverse of the *system* changes, and nothing else. |
| `teardown.sh` | you | The whole uninstall, in order, reporting every step and continuing past a failure. Raises the one prompt for `uninstall.sh`. `--dry-run` prints and runs nothing. |
| `self-delete.sh` | you | Removes the `.app` from outside itself, after the app's pid is gone. Refuses anything that is not our bundle. |
| `lib.sh` | root | Shared helpers: validation, the `/etc/hosts` transform, `lo0`, DNS, the forwarder. **Must be shipped in the same directory as the two scripts**; they refuse to run without it. |
| `prompt.ts` | you | The `osascript` wrapper. The only place a password is ever requested. `--if-needed` skips the prompt entirely when the agent is already running. |

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

`teardown.sh` adds four of its own, and always fills in `LA_OWNER` for the privileged half:

| Variable | Required | Meaning |
|---|---|---|
| `LA_APP_BUNDLE` | no | The `.app` to remove. Unset means the app is left alone. |
| `LA_WAIT_PID` | no | The pid to outlive before the bundle is removed — the running app itself. |
| `LA_LOG_DIR` | no | Removed as step 4, so the app leaves no log directory behind either. |
| `LA_KEYCHAIN` | no (`~/Library/Keychains/login.keychain-db`) | Where the local CA is trusted. |

`LA_CONFIG_DIR`, `LA_HOSTS_PATH` and `LA_MANAGED_IPS` are re-exported by `apply.sh` to the
agent it starts, so the long-lived root process is bound by the same three answers the
one-shot script was. The agent reconciles only when it is really root; `LA_AGENT_RECONCILE=0`
turns that off and leaves a plain forwarder, and `=1` forces it on for development against a
temp hosts file.

`LA_IFCONFIG`, `LA_DSCACHEUTIL`, `LA_KILLALL`, `LA_PLUTIL`, `LA_CHOWN`, `LA_OSASCRIPT`,
`LA_SECURITY`, `LA_OPENSSL` and `LA_TEST_MODE` exist so the
unit tests can drive the scripts against stubs and a temp hosts file. They default to the
absolute system paths, and the tests are the only thing that ever sets them: no test may
touch the real `/etc/hosts`, the real `lo0` or run a real privileged command.
