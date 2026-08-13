# Localhost Aliases

Give your local dev servers real names. `http://myapp.local` instead of `http://localhost:3000`,
so every project is recognisable at a glance in your browser's tab bar and history.

```
  myapp.local        ──────────────▶  127.0.0.3:80  ──▶  127.0.0.1:3000
  api.myapp.local    ──────────────▶  127.0.0.4:80  ──▶  127.0.0.1:3001
  docs.local         ──────────────▶  127.0.0.5:80  ──▶  127.0.0.1:4321
```

- **Menu-bar app** — runs in the background, shows what's live, one click to stop.
- **Web dashboard** — create, edit and delete aliases; no native window, just a local server.
- **MCP server** — one-click install for Claude Code and Codex, so your agent knows which
  URL belongs to which project.
- **Project-local config** — an optional `.localhost-aliases.json` in a repo pins its aliases.

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

Privileged work happens in **one batch behind one macOS admin prompt** (`osascript … with
administrator privileges`) — when you add or remove an alias, and once at launch if a reboot
has cleared the `lo0` addresses. **Changing only a port never prompts**: the forwarder watches
its routes file and reloads by itself.

The forwarder runs as root, and a normal process cannot kill root. So it owns its own lifetime:
the app touches a liveness file every few seconds, and the forwarder exits on its own when that
stops. Quitting the app is clean, with no second prompt.

### `http://` only

The forwarder never sees inside the traffic, so it cannot terminate TLS. **Project aliases are
`http://` only.** `https://` is possible for the dashboard alone, because we own that server.

## Install

```sh
git clone <this repo> && cd localhost-aliases
make bundle      # builds dist/LocalhostAliases.app
make install     # copies it into /Applications
```

Launch it from `/Applications`, then follow the onboarding — it explains exactly what will
change before anything happens, and asks for your password once.

To remove every trace, including the `/etc/hosts` block and the `lo0` addresses:

```sh
make uninstall   # one admin prompt
```

## Usage

Create an alias in the dashboard: a name (`myapp`) and a port (`3000`). Adding or removing an
alias needs the admin prompt; changing its port afterwards takes effect immediately.

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

## Notes on `.local`

`.local` is formally reserved for mDNS/Bonjour. Explicit `/etc/hosts` entries take
precedence on macOS, so it works — but if you hit resolution oddities on a network with
heavy Bonjour use, switch the TLD to `.test` in Settings. Everything re-resolves instantly.
