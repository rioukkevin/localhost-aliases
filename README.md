# Localhost Aliases

Give your local dev servers real names. `http://myapp.local` instead of `http://localhost:3000`,
so every project is recognisable at a glance in your browser's tab bar and history.

```
  myapp.local        ──────────────▶  :3000
  api.myapp.local    ──────────────▶  :3001
  docs.local         ──────────────▶  :4321
```

- **Menu-bar app** — runs in the background, shows what's live, one click to stop.
- **Web dashboard** — create, edit and delete aliases; no native window, just a local server.
- **MCP server** — one-click install for Claude Code and Codex, so your agent knows which
  URL belongs to which project.
- **Project-local config** — an optional `.localhost-aliases.json` in a repo pins its aliases.

## How it works

DNS can only map a name to an IP, never to a port. So this does two things:

1. Writes a managed block in `/etc/hosts` pointing each alias at `127.0.0.1`.
2. Runs a reverse proxy on `:80`/`:443` that reads the `Host` header and forwards to the
   right local port.

Step 2 needs a privileged port, so a small root LaunchDaemon owns the proxy and the hosts
file. Everything else — the dashboard, the config, the MCP server — runs as you. The root
component is deliberately tiny and stateless: it accepts a complete desired-state payload
over a `0600` unix socket and reconciles. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

```sh
git clone <this repo> && cd localhost-aliases
make install     # one sudo prompt: installs the helper + launch-at-login agent
```

Then open the dashboard at <http://127.0.0.1:7788> (or via the menu-bar icon).

To remove every trace, including the `/etc/hosts` block:

```sh
make uninstall
```

## Usage

Create an alias in the dashboard: a name (`myapp`) and a port (`3000`). It is live
immediately at `http://myapp.local` — no restart, no browser cache flush.

If nothing is listening on the target port yet, the proxy serves a "nothing running here"
page that auto-refreshes and turns into your app the moment you start it.

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

The **MCP** tab installs the server into Claude Code or Codex in one click (with a
copy-paste snippet as a fallback). Once installed, your coding agent can list the aliases
and projects on the machine, register new ones, and link a folder to a URL.

## Development

```sh
make dev      # helper + dashboard, nothing installed system-wide
make test     # unit tests (bun test)
make test-e2e # headless Chromium dashboard tests + MCP protocol tests
```

## Notes on `.local`

`.local` is formally reserved for mDNS/Bonjour. Explicit `/etc/hosts` entries take
precedence on macOS, so it works — but if you hit resolution oddities on a network with
heavy Bonjour use, switch the TLD to `.test` in Settings. Everything re-resolves instantly.
