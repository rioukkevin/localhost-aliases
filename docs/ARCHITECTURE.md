# localhost-aliases — architecture spec

Read this before writing code. `packages/core/src/types.ts` and `packages/core/src/paths.ts`
are the frozen contract; do not edit them without saying so explicitly in your report.

## Problem

DNS maps names to IPs, never to ports. So `myapp.local -> localhost:3000` needs two things:

1. **Name resolution** — a `127.0.0.1 myapp.local` line in `/etc/hosts` (managed block).
2. **Port routing** — a reverse proxy owning `:80`/`:443` that reads the `Host` header and
   forwards to the right upstream port.

## Processes

| Process | User | Lifetime | Owns |
|---|---|---|---|
| `packages/helper` | **root** (LaunchDaemon `dev.localhost-aliases.helper`) | boot | `:80`, `:443`, `/etc/hosts` managed block, DNS flush |
| `packages/web` | you (LaunchAgent `dev.localhost-aliases.web`) | login | config file, REST API, Next.js dashboard on `127.0.0.1:7788` |
| `packages/mcp` | you (stdio) | per client session | MCP protocol, project workspace files |
| `apps/tray` | you (`.app`) | login | menu-bar UI, supervises `web` |

Data flow: dashboard/MCP -> `web` HTTP API -> writes config.json -> pushes an `ApplyRequest`
to `helper` over the unix socket -> helper rewrites `/etc/hosts`, flushes DNS, swaps routes.

The helper is **stateless and dumb on purpose**: it accepts a complete desired-state
`ApplyRequest` and reconciles. All policy lives in user space. This keeps the root-privileged
attack surface to one file.

## Security boundary

- Socket `/var/run/localhost-aliases.sock`, created by root then `chown` to the installing
  user's uid, mode `0600`. No other local user can reach it.
- The helper never executes user-supplied strings. It shells out only to fixed commands:
  `dscacheutil -flushcache` and `killall -HUP mDNSResponder`.
- Hostnames arriving in `ApplyRequest` must be re-validated by the helper before touching
  `/etc/hosts` (defence in depth — assume the caller is compromised). Reject anything not
  matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`, anything in
  `RESERVED_NAMES`, and any string containing whitespace or `#`.
- `/etc/hosts` is only ever modified between `HOSTS_BEGIN` / `HOSTS_END` markers. Content
  outside the markers is preserved byte-for-byte. Write atomically: temp file in `/etc`,
  `chmod 0644`, `rename()`.

## packages/core

Pure logic, no side effects at import time. Modules (all named exports, `.ts` extensions in
imports — this is a Bun workspace):

- `types.ts`, `paths.ts` — **frozen contract, already written**
- `validation.ts` — `validateName`, `validatePort`, `assertValidAlias(input, existing, opts?)`.
  Throws `ValidationError` with per-field issues. Rules: name lowercase `[a-z0-9-]` labels
  separated by dots, 1–63 chars per label, no leading/trailing hyphen, not in `RESERVED_NAMES`,
  unique per config (case-insensitive); port integer 1–65535; target must be a loopback
  literal (`127.0.0.1`, `::1`, `localhost`) — refuse arbitrary remote hosts.
- `store.ts` — load/save `Config` as JSON at `configPath()`. Creates the dir, seeds
  `DEFAULT_CONFIG` with `aliases: []` on first read, writes atomically, migrates unknown
  shapes defensively. CRUD: `listAliases`, `createAlias`, `updateAlias`, `deleteAlias`,
  `updateSettings`. Every mutation returns the new `Config`. Serialize writes with an
  in-process mutex so concurrent API calls cannot interleave.
- `hosts.ts` — `renderBlock(hostnames): string`, `applyBlock(content, hostnames): string`
  (pure string transform, must be idempotent and preserve surrounding content),
  `parseBlock(content): string[]`. **These are the most heavily unit-tested functions.**
- `certs.ts` — local CA. `ensureCA()` generates a root CA (only if absent),
  `issueLeaf(hostnames)` issues one leaf cert whose SANs cover every hostname (plus
  `localhost`, `127.0.0.1`). Use `node:crypto` + a minimal X.509 writer, or shell out to
  `/usr/bin/openssl` (present on macOS) with a generated config file — openssl is fine and
  simpler; write the temp openssl config under `caDir()`. `isCATrusted()` shells
  `security find-certificate -c "localhost-aliases Local CA" -Z /Library/Keychains/System.keychain`.
  Never regenerate the CA if it exists (the user has trusted it).
- `helper-client.ts` — typed client over the unix socket using
  `fetch(url, { unix: SOCKET_PATH })`. `helperStatus()`, `helperApply(req)`,
  `helperAvailability()` -> `HelperUnavailable`. All calls have a 2s timeout and never throw
  on connection failure — they return a discriminated result so the dashboard degrades
  gracefully when the helper is not installed.
- `workspace.ts` — read/write `.localhost-aliases.json` (`WORKSPACE_FILENAME`) in a project
  folder. `readWorkspace(dir)`, `writeWorkspace(dir, file)`, `mergeWorkspaceAliases(dir, entries)`.
  Preserves unknown keys. Usage is optional: a missing file is not an error.
- `mcp-install.ts` — one-click MCP registration.
  - Claude Code: JSON at `claudeConfigPath()`, top-level `mcpServers["localhost-aliases"]`.
  - Codex: TOML at `codexConfigPath()`, table `[mcp_servers.localhost_aliases]`.
    Hand-write the TOML section (no toml dep): if the table exists, replace it in place;
    otherwise append. Preserve everything else verbatim.
  - Both: back up the existing file to `<path>.bak-<n>` before writing, return the exact
    snippet so the UI can offer copy-paste as a fallback. `mcpServerSpec()` returns
    `{ command: "bun", args: [<abs path to packages/mcp/src/index.ts>], env: { LA_DASHBOARD_PORT } }`.
  - `detectClients()` -> `{ claude: McpClientState, codex: McpClientState }`.
- `probe.ts` — `probePort(host, port, timeoutMs)` -> `AliasStatus` via a TCP connect attempt
  (`Bun.connect`), and `probeAll(aliases)` with bounded concurrency (8) and a 300ms timeout.

## packages/helper (root daemon)

Single Bun entrypoint. Responsibilities, nothing more:

- `Bun.serve({ unix: SOCKET_PATH })` control API: `GET /status` -> `HelperStatus`,
  `POST /apply` (body `ApplyRequest`) -> `ApplyResponse`, `POST /shutdown`.
  On startup: unlink a stale socket, then after bind `chown` the socket to
  `process.env.LA_OWNER_UID` and `chmod 0600`.
- Reverse proxy on `httpPort` (and `httpsPort` when `tls` is provided). Route by lowercased
  `Host` header minus port. Forward method, headers, and body; strip hop-by-hop headers; set
  `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`. **Must support WebSocket
  upgrades** (dev servers need HMR) — use `Bun.serve`'s `websocket` handler with a proxied
  client socket, or fall back to raw socket piping on upgrade.
- Unknown host -> branded 404 page listing known aliases. Known host but upstream refuses
  connection -> the **offline page**: a styled "nothing is listening on :3000" page, HTTP 502,
  with the alias name, the expected port, and a hint to start the dev server. It must
  auto-refresh (`<meta http-equiv="refresh" content="3">`) so the page becomes the app the
  moment the server boots. Keep it self-contained (inline CSS), dark/light aware via
  `prefers-color-scheme`, and visually consistent with the dashboard design language below.
- Re-binding: `apply` with changed ports tears down and rebinds listeners without dropping
  the control socket.
- Logs to stdout; launchd redirects to `logDir()`.

## packages/web (Next.js 15, app router, Bun runtime)

This process **is** the API server. Route handlers call `@localhost-aliases/core` directly.
After any mutation: recompute routes and push `ApplyRequest` to the helper, then return the
fresh state. Never let a helper failure lose a config write — persist first, apply second, and
surface `helper` errors as a non-fatal warning in the response.

Endpoints (all under `/api`, JSON, errors as `{ error: string, issues?: ValidationIssue[] }`
with 400/404/500):

- `GET /api/aliases` -> `{ aliases: AliasView[] }` (status probed)
- `POST /api/aliases` -> `{ alias: AliasView, warning?: string }`
- `PATCH /api/aliases/[id]`, `DELETE /api/aliases/[id]`
- `GET /api/status` -> `SystemStatus`
- `GET /api/settings` / `PATCH /api/settings` (tld, ports, https)
- `POST /api/apply` — force re-apply desired state to the helper
- `GET /api/projects` -> `{ projects: Project[] }`
- `POST /api/projects/link` `{ path, aliases }` -> writes the workspace file
- `GET /api/mcp` -> client detection; `POST /api/mcp/install` `{ client }` -> writes config
- `GET /api/health` -> `{ ok: true }` (used by the tray and e2e)

Add `export const dynamic = "force-dynamic"` to every route handler and page that reads state.

### Design language (this is a product surface — make it excellent)

Concept: **a patchbay**. Each alias is a physical-feeling patch cable connecting a *name* on
the left to a *port* on the right. This motif is the identity of the app; carry it through.

- Palette. Dark (default): canvas `#0A0A0B`, raised `#111113`, hairline borders
  `rgba(255,255,255,0.08)`, primary text `#F2F2EF`, muted `#8A8A85`, accent **lime `#D6FF4B`**,
  live green `#4ADE80`, down amber `#F5A524`, danger `#FF6B5A`.
  Light: canvas `#FAFAF8`, raised `#FFFFFF`, borders `rgba(0,0,0,0.10)`, ink `#111112`, muted
  `#6B6B66`, accent `#5B7A00`. Support both via CSS custom properties on `:root` +
  `@media (prefers-color-scheme: dark)`; no theme flash.
- Type: `ui-sans-serif/-apple-system` for UI, `ui-monospace/"SF Mono"` for every hostname,
  port and path. Hostnames are the hero element — large, monospace, tight tracking.
- Motion: the connector line between name and port animates (a slow dash-offset drift) only
  when the upstream is **up**; static and dimmed when down. Respect
  `prefers-reduced-motion: reduce`.
- No rounded-card-with-shadow bootstrap look. Hairline rules, generous whitespace, one accent
  colour used sparingly, flat surfaces. Think oscilloscope / studio hardware, not SaaS.
- Feedback is a hard requirement: optimistic updates with rollback on failure, inline
  field-level validation (name/port collisions surfaced before submit), a toast system for
  every mutation, per-row status dots polling `/api/aliases` every 5s, a copy-URL affordance
  on each row, an explicit banner when the helper is not installed/running with the exact
  `sudo` command to fix it (copyable), and a visible "applying…" state while the helper
  reconciles.
- Views: **Aliases** (the patchbay, primary), **Projects** (folders and their aliases),
  **Settings** (tld, ports, https, launch-at-login), **MCP** (one-click install cards for
  Claude Code and Codex with detected/installed state and a copy-paste fallback).
- Tailwind v4 (`@import "tailwindcss"`, CSS-first `@theme`). No component library, no
  shadcn — this UI is bespoke. Keep components small and in `components/`, data fetching in
  `lib/api.ts`, and put all shared state in a single client-side store hook.
- Every interactive element needs a visible focus ring and a real `aria-label`. Test ids:
  `data-testid` on every element e2e needs (`alias-row`, `alias-create-form`, `alias-name-input`,
  `alias-port-input`, `alias-submit`, `alias-delete`, `toast`, `helper-banner`, `mcp-install-claude`,
  `mcp-install-codex`, `nav-aliases|projects|settings|mcp`).

## packages/mcp

Stdio MCP server, `@modelcontextprotocol/sdk`. It is a thin client of the web API
(`dashboardUrl()`); it must not touch `/etc/hosts` or the config file directly — except
workspace files, which are project-local and safe.

Transparency is a requirement: the server's `instructions` field must explain, in plain
language, what the system does (writes `/etc/hosts` via a root helper, runs a proxy on :80),
what it will and will not change, and that workspace files are optional.

Tools:
- `list_aliases` — every alias with hostname, url, port, project, live status.
- `list_projects` — folders with attached aliases + whether a workspace file exists.
- `create_alias` `{ name, port, projectPath?, description? }`
- `delete_alias` `{ name | id }`
- `link_project` `{ path, aliases: [{name, port, description?}] }` — writes/merges
  `.localhost-aliases.json` **and** registers the aliases.
- `get_usage_instructions` — returns the transparency doc: how to use aliases in a project,
  the workspace file format, and the fact that it is entirely optional.
Also expose `list_aliases` output as an MCP **resource** (`localhost-aliases://aliases`).

Every tool returns human-readable text content AND a `structuredContent` payload. When the
web server is unreachable, return a clear, actionable error (how to start it) rather than a
stack trace.

## apps/tray (Swift, AppKit)

`NSStatusItem`, `LSUIElement=true` (no dock icon, no window). Menu:
running/stopped status with alias count, **Open Dashboard** (opens `dashboardUrl()`),
list of aliases (click -> open that URL), **Restart server**, **Stop server**, **Quit**.
Icon: template `NSImage` drawn from SF Symbols, tinted by state (idle/running/error).
It supervises `packages/web` as a child `Process` (bun) and polls `/api/health` every 5s.
Build with `swiftc` into a real `.app` bundle via `apps/tray/Makefile` + `Info.plist`.

## scripts/

- `install.sh` — the one `sudo` step. Copies the runtime to `INSTALL_ROOT`, writes the helper
  LaunchDaemon plist (with `LA_OWNER_UID` set to the invoking user), `launchctl bootstrap`s it,
  installs the LaunchAgent for the web server, optionally trusts the local CA. Idempotent.
- `uninstall.sh` — reverses all of it, including stripping the `/etc/hosts` managed block.
- `dev.sh` — runs helper (via sudo) + web in dev without installing anything.

## Testing

- Unit (`bun test`, colocated in `packages/*/test/`): hosts block transforms (idempotency,
  preservation, removal, malformed input), validation rules, store CRUD + concurrency,
  workspace merge, MCP config writers (JSON + TOML round-trips, backup behaviour), route
  building, cert SAN construction. Use `LA_CONFIG_DIR` / `LA_HOSTS_PATH` temp dirs — **no test
  may ever touch the real `/etc/hosts` or `~/.config`.**
- E2E (`e2e/`, Playwright, headless Chromium): boot the Next.js server against a temp config
  dir with a **stubbed helper** (a fake unix-socket server in `e2e/fixtures/fake-helper.ts`
  implementing the same protocol), then drive the real UI: create alias, see it in the list,
  validation errors, delete, settings change, MCP install cards.
- MCP tests: spawn `packages/mcp` over stdio, run `initialize` / `tools/list` / `tools/call`
  against a live web server on a temp port, assert schemas and error paths.

## Environment contract (added after Phase 1)

Every process reads these. Defaults are the production values; the overrides exist so tests,
`scripts/dev.sh` and the e2e fake helper can run without root and without touching the system.

| Variable | Read by | Default | Purpose |
|---|---|---|---|
| `LA_SOCKET_PATH` | helper (bind), core `helperSocketPath()` (connect) | `/var/run/localhost-aliases.sock` | **The helper MUST bind this, not the frozen `SOCKET_PATH` constant.** `/var/run` is root-only, so e2e cannot use it. |
| `LA_HTTP_PORT` | helper | `80` | Initial HTTP listener port, before the first `ApplyRequest` arrives. |
| `LA_HTTPS_PORT` | helper | `443` | Initial TLS listener port. |
| `LA_OWNER_UID` | helper | — | uid the control socket is `chown`ed to after bind. Set by `install.sh` from `SUDO_USER`. |
| `LA_HOSTS_PATH` | core `hosts.ts` | `/etc/hosts` | Redirects hosts writes to a temp file in tests. |
| `LA_CONFIG_DIR` | core `store.ts`, `certs.ts` | `~/.config/localhost-aliases` | Config + CA location. |
| `LA_DASHBOARD_PORT` | web, mcp, tray | `7788` | Dashboard bind port and the URL every client derives. |
| `LA_CLAUDE_CONFIG` / `LA_CODEX_CONFIG` | core `mcp-install.ts` | `~/.claude.json`, `~/.codex/config.toml` | MCP client config targets. |
| `LA_NEXT_DIST_DIR` | web `next.config.ts` (`lib/dist-lock.ts`) | `.next` | Next.js build directory. Anything that boots the dashboard for a test must set it: `next dev` wipes whatever directory it is given, so sharing `.next` destroys the production build. |
| `LA_MCP_ENTRYPOINT` | core `mcp-install.ts` | derived | Absolute path to `packages/mcp/src/index.ts`. Normally resolved automatically (module dir, then a walk up from the cwd, then `INSTALL_ROOT`), each candidate checked on disk because bundlers erase `import.meta.dir`. Set it when the layout is non-standard. |

### Additional core exports beyond CORE_API.md

Phase 1 added these; they are part of the contract now:
`DEFAULT_TARGET`, `LOOPBACK_TARGETS`, `HELPER_TIMEOUT_MS`, `MCP_SERVER_KEY`, `MCP_CODEX_TABLE`,
`WORKSPACE_SCHEMA_URL`, `normalizeTld`, `helperSocketPath()`, `helperInstallCommand()`,
`helperStartCommand()`.

## Runtime pitfall: the dashboard MUST run under Bun (verified Phase 1→2)

`next dev` / `next start` re-exec under **Node** by default (Node 24 via nvm on this machine).
`@localhost-aliases/core` is Bun-native — `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.connect`,
and `fetch(url, { unix })` — so every route handler died with `ReferenceError: Bun is not defined`.

The fix, already applied to `packages/web/package.json`, is the `--bun` flag:

```jsonc
"dev":   "bun --bun next dev   -H 127.0.0.1 -p ${LA_DASHBOARD_PORT:-7788}",
"start": "bun --bun next start -H 127.0.0.1 -p ${LA_DASHBOARD_PORT:-7788}",
"build": "next build"   // build runs fine under node; only the server runtime matters
```

Verified working: `bunGlobal: "object"`, `process.versions.bun: "1.2.5"`, and a route handler
calling `loadConfig()` returning real data in **both** dev and production start.

Consequences everyone must respect:
- Anything that launches the dashboard (the tray's `ServerProcess`, the LaunchAgent in
  `install.sh`, `dev.sh`, the e2e web-server fixture) must go through these npm scripts or
  replicate `bun --bun`. Launching `next` directly re-introduces the bug.
- `next build` requires `allowImportingTsExtensions: true` in `packages/web/tsconfig.json`
  (core imports use explicit `.ts` extensions) plus `transpilePackages: ["@localhost-aliases/core"]`
  and `experimental.externalDir` in `next.config.ts`. All three are already set — do not remove them.
- Running `next dev` deletes the production `.next` build. Re-run `next build` before `next start`.
  Tests must never rely on that discipline: set `LA_NEXT_DIST_DIR` (see the environment
  contract) so the run gets its own build tree and the production build survives.

## Build-directory lock (added Phase 3)

Two Next.js servers sharing one `distDir` overwrite each other's manifests and then hang with
no error output at all — the worst possible failure mode, and one that cost real hours. It is
now impossible: `next.config.ts` claims `<distDir>.lock` (beside the directory, because
`next dev` wipes the directory itself) recording pid and port, and refuses to start when a
*live* process on a *different* port already holds it. Same port means the same server tree —
`next dev` loads the config twice, once in the CLI process and once in the server process it
spawns — and a stale pid means the previous owner died. Builds only warn. Logic and its unit
tests: `packages/web/lib/dist-lock.ts`, `packages/web/test/dist-lock.test.ts`.

## HTTPS (proven end to end, Phase 3)

`packages/helper/test/https.test.ts` runs the whole chain with nothing stubbed:
`config.https = true` -> `issueLeaf()` -> `ApplyRequest` over the control socket -> the helper
binds its TLS listener -> `curl --cacert <local CA> --resolve <alias>:18443:127.0.0.1` reaches
the upstream. One leaf covers every alias hostname (SANs are asserted against the real X.509),
the offline and 404 pages are checked over TLS, and turning HTTPS off stops the listener while
plain HTTP keeps serving.

`issueLeaf()` reuses the leaf on disk when it already covers exactly the requested SAN set
(recorded in `caDir()/leaf.json`). This is load-bearing, not an optimisation: it runs on every
apply, and fresh TLS material on every apply makes the helper rebind :443 — dropping every
live HTTPS request and HMR socket — each time an alias is edited.

## Helper drift recovery (added Phase 4)

The helper holds routes only because someone applied them. The dashboard pushes on every
mutation and once at startup (`instrumentation.ts`), which covers "daemon boots, then
dashboard boots". It did **not** cover the reverse: the helper restarting (crash, auto-update,
`launchctl kickstart`) under a dashboard that keeps running. `/etc/hosts` still resolved every
alias, so every site silently became the branded 404 page until the user happened to edit
something.

`packages/web/lib/reconcile.ts` closes it. `getStatus()` already fetches a fresh `HelperStatus`
on every `GET /api/status`, and the dashboard already polls that, so reconciliation rides that
poll and owns **no timer of its own**:

- **Detection** is a fingerprint of everything `HelperStatus` exposes — route count, managed
  hostnames (set, not order), both listener ports, whether TLS is listening — compared against
  the same fingerprint derived from `Config`. No epoch counter, so `packages/core/src/types.ts`
  is untouched: this process is the only writer of helper state, so the only way it diverges
  behind our back is the helper losing all of it, which reads unambiguously as `routes: 0`.
- **Repair** is one `pushDesiredState()`, single-flighted (concurrent dashboards poll the same
  server), followed by a re-read so the response reports the state it restored.
- **Backoff** counts *consecutive ineffective attempts* — an apply that errored or one that was
  accepted without taking effect both count — and doubles from 5s to a 5-minute cap. A healthy
  comparison resets it, so a successful repair costs exactly one apply.
- **Logging** is once per transition (`logOnce`), never per tick.

Regression test: `packages/web/test/reconcile.test.ts`, against a real unix-socket helper stub.
