# Localhost Aliases

Give your local dev servers real names. `http://myapp.test` instead of `http://localhost:3000`,
so every project is recognisable at a glance in your browser's tab bar and history.

```
  myapp.test        ──────────────▶  127.0.0.3:80  ──▶  127.0.0.1:3000
  api.myapp.test    ──────────────▶  127.0.0.4:80  ──▶  127.0.0.1:3001
  docs.test         ──────────────▶  127.0.0.5:80  ──▶  127.0.0.1:4321
```

- **Menu-bar app** — runs in the background, shows what's live, one click to stop.
- **Web dashboard** — create, edit and delete aliases; no native window, just a local server.
- **MCP server** — one-click install for Claude Code and Codex, so your agent knows which
  URL belongs to which project.
- **Project-local config** — an optional `.localhost-aliases.json` in a repo pins its aliases.
- **`https://`, optionally** — off by default; one switch in Settings and every alias answers
  on `https://` too, with `http://` still working.

## How it works

DNS maps a name to an IP, never to a port. So each alias gets **its own loopback IP**, and a
**raw TCP forwarder** carries `:80` on that IP to your dev server's port:

1. `/etc/hosts` gets a managed block pointing each alias at its own `127.0.0.x`.
2. Each of those addresses is added to `lo0`.
3. A small root process splices `127.0.0.x:80` to `127.0.0.1:<your port>`.

It forwards **raw bytes** and parses nothing, so WebSockets, HMR and any non-HTTP protocol
pass straight through. See [docs/V2.md](docs/V2.md) for the full architecture.

### Nothing is permanently installed

There is no LaunchDaemon, no `SMAppService`, no privileged helper and no `sudo` installer.
The only changes to your machine are the `/etc/hosts` block and the `lo0` addresses, and both
are reversed by `make uninstall`.

### One admin prompt per app launch — and what that buys

You are asked for your password **once, when the app starts** (`osascript … with administrator
privileges`). That prompt starts the **root agent**: a long-lived root process that is also the
forwarder. From then on, adding an alias, removing one, renaming one or changing a port **does
not prompt again**. The app writes what it wants into `~/.config/localhost-aliases/desired-state.json`
and the agent reconciles the machine to it.

The forwarder runs as root, and a normal process cannot kill root. So it owns its own lifetime:
the app touches a liveness file every few seconds, and the agent exits on its own when that
stops. Quitting the app is clean, with no second prompt.

### The security tradeoff, stated plainly

**`desired-state.json` is writable by your user account, and a root process acts on it.** Any
process running as you can therefore ask root to edit `/etc/hosts` and add loopback addresses,
without a password prompt, for as long as the app is running. That is a real local privilege
escalation and it is the price of not being asked for your password on every edit. If you would
rather pay per edit, quit the app — nothing runs as root once it is closed.

It is bounded by validation the agent performs itself, never trusting the file
([`packages/forwarder/src/desired.ts`](packages/forwarder/src/desired.ts)):

- hostnames are re-validated on every read — whitespace, `#`, newlines, over-long labels and
  system names like `localhost` are refused;
- only `127.0.0.2`–`127.0.0.254` is ever added to or removed from `lo0`. `127.0.0.1` cannot be
  touched, and an address the agent did not allocate is never removed;
- `/etc/hosts` edits are confined to the managed marker block, written atomically, and refused
  outright if a single byte outside the markers would change;
- forwarders bind loopback only, and a port at or below 1024 only on a pool address — so the
  file cannot make root hold `127.0.0.1:22` and splice it somewhere;
- one bad entry rejects the **whole** file, leaving the previous state exactly as it was, with
  the reason in the log.

Nothing named in the file is ever executed. See
[`packages/privileged/README.md`](packages/privileged/README.md) for the full surface.

### `https://`, optionally

Off by default; turn it on in Settings and every alias also answers on `https://`, with `http://`
still working so nothing you have bookmarked breaks.

This is possible because **each alias owns its own loopback address**. A listener on
`127.0.0.3:443` already knows which alias it is, so it presents that certificate without reading
a byte — no SNI parsing, no HTTP parsing. After the handshake it is the same raw splice, which is
why WebSockets and HMR keep working.

The certificate is issued automatically. The one step that is not automatic is trusting the local
authority that signs it: macOS asks for your keychain password, and an app that installs a trusted
root without asking would be indistinguishable from malware. Settings shows the exact command.

Firefox keeps its own list of trusted authorities and will still warn until you add it there too.

## Install

```sh
git clone <this repo> && cd localhost-aliases
make bundle      # builds dist/LocalhostAliases.app
make install     # copies it into /Applications
```

Launch it from `/Applications`, then follow the onboarding — it explains exactly what will
change before anything happens, and asks for your password once per app launch.

To remove every trace, including the `/etc/hosts` block and the `lo0` addresses:

```sh
make uninstall   # one admin prompt
```

## Usage

Create an alias in the dashboard: a name (`myapp`) and a port (`3000`). With the root agent
running, adding, removing and re-porting an alias all take effect immediately, with no further
prompt. If the agent is not running the dashboard says so and offers to start it — that is the
one prompt.

### Project workspace file (optional)

Drop a `.localhost-aliases.json` in a repo to pin its aliases:

```json
{
  "aliases": [
    { "name": "myapp", "port": 3000, "description": "web" },
    { "name": "api.myapp", "port": 3001, "description": "API" }
  ]
}
```

This is entirely optional — aliases created in the dashboard work without it.

### MCP

The setup flow installs the MCP server into Claude Code or Codex in one click (with a
copy-paste snippet as a fallback). Once installed, your coding agent can list the aliases
and projects on the machine, register new ones, and link a folder to a URL.

## Development

```sh
make dev      # dashboard only, nothing installed, no privileges
make test     # unit tests (bun test)
```

Unit tests only — there is no Playwright and no e2e suite. No test may touch `/etc/hosts`,
`lo0` or `~/.config/localhost-aliases`; they use the `LA_*` path overrides and ports above 1024.

## Releasing

```sh
make sign      # codesign with your Developer ID (set SIGN_IDENTITY, or "-" for ad-hoc)
make notarize  # needs NOTARY_ARGS, see packages/build/notarize.sh
make dmg
```

## The TLD

Aliases end in **`.test`**. It is the default, and three families of TLD are refused outright:
`.local`, the HSTS-preloaded TLDs (`.dev`, `.app`, `.page` and the rest of that list), and
`.localhost`.

- `.test` is reserved by [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.2) for
  exactly this purpose: never delegated, never publicly resolvable, and nothing on macOS
  intercepts it — an `/etc/hosts` entry answers in microseconds.
- `.local` belongs to mDNS/Bonjour ([RFC 6762](https://www.rfc-editor.org/rfc/rfc6762)). On
  macOS `mDNSResponder` claims it, and every lookup waits out a multicast query — **about five
  seconds per name, whether or not the name is in `/etc/hosts`**.
- HSTS-preloaded TLDs are force-upgraded to `https://` by Chrome and Safari before a request is
  ever sent. Aliases answer on `http://` unless you turn HTTPS on, so the browser would fail
  with a TLS error that points nowhere near the real cause — and with HTTPS on it would still
  fail until the local authority is trusted.
- `.localhost` is resolved to `127.0.0.1` by macOS itself (RFC 6761 §6.3), ignoring
  `/etc/hosts`. Each alias owns its own `127.0.0.x`, so the name would never reach its
  forwarder.

The dashboard offers `test`, `internal`, `lan`, `home.arpa` and `example`; each is reserved or
private by standard and answers from `/etc/hosts`. A rejected TLD is rejected with its own
reason, not a generic "not allowed" — otherwise you just try the next broken suffix.

None of this makes `.local` broken: Bonjour resolves the names it actually owns quickly, which
is what it is for. It is simply the wrong carrier for a name that lives in `/etc/hosts`.

See [docs/TLD.md](docs/TLD.md) for the measurements and how to reproduce them.
