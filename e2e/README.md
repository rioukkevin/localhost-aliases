# e2e — the dashboard, driven for real

Headless Chromium against the **real** Next.js dashboard, the **real** REST API and the
**real** `@localhost-aliases/core`. The only thing that is faked is the one component that
needs root.

```bash
bun run test:e2e            # from the repo root
bun run --cwd e2e test      # the same thing
bun run --cwd e2e test -- tests/resilience.spec.ts   # one file
bun run --cwd e2e report    # open the HTML report of the last run
```

The first run builds the dashboard (about a minute); later runs reuse that build and the
whole suite finishes in a few seconds.

## What it covers

| Spec | What it pins down |
|---|---|
| `aliases.spec.ts` | First-run empty state; create an alias and see the row; the fake helper receives the route; the managed block appears in the hosts file; copy-URL; delete behind a confirmation removes both the row and the hosts entry. |
| `validation.spec.ts` | Bad characters, reserved names, duplicates and out-of-range ports are shown inline **before** submit; pressing submit surfaces the error instead of sending; nothing reaches the config, the helper or the hosts file. The API refuses the same four payloads. |
| `settings.spec.ts` | Changing the TLD renames every hostname, rewrites the managed block and re-pushes the full desired state; an invalid TLD blocks apply entirely. |
| `mcp.spec.ts` | Install cards report detected / installed state, always offer the copy-paste snippet, and one-click install writes the client config, preserves what it does not own, and keeps a numbered backup. |
| `resilience.spec.ts` | **The most important one.** With no helper at all — the real first-run state — the dashboard still renders, the banner names the exact `sudo` command, and creating an alias persists with a warning instead of a 500. |

## How it stays off your machine

Nothing in this suite runs `sudo`, `launchctl` or `security(1)`, and nothing it writes lives
outside `/tmp`. Every process it starts gets the `LA_*` overrides from the environment
contract in `docs/ARCHITECTURE.md`:

| Variable | Points at | Instead of |
|---|---|---|
| `LA_CONFIG_DIR` | `/tmp/la-e2e/config` | `~/.config/localhost-aliases` |
| `LA_HOSTS_PATH` | `/tmp/la-e2e/hosts` | `/etc/hosts` |
| `LA_SOCKET_PATH` | `/tmp/la-e2e.sock` | `/var/run/localhost-aliases.sock` |
| `LA_CLAUDE_CONFIG` | `/tmp/la-e2e/mcp/claude.json` | `~/.claude.json` |
| `LA_CODEX_CONFIG` | `/tmp/la-e2e/mcp/codex.toml` | `~/.codex/config.toml` |
| `LA_DASHBOARD_PORT` | `7799` | `7788` |
| `LA_NEXT_DIST_DIR` | `packages/web/.next-e2e` | `packages/web/.next` |

`fixtures/fake-helper.ts` is what makes that possible. It is a Bun process serving the same
control protocol as `packages/helper` — `GET /status`, `POST /apply`, `POST /shutdown` over
a unix socket — and it reconciles the managed block into the temp hosts file with core's real
`applyBlock`. What it does **not** do is everything that needs privileges: it never binds
:80/:443, never flushes DNS, and never goes near `/etc/hosts`. Every `ApplyRequest` it
receives is journalled to `/tmp/la-e2e/applies.json`, which is how a test asserts what the
dashboard actually pushed.

The socket lives directly in `/tmp` on purpose: `sockaddr_un.sun_path` caps a unix socket
path at 104 bytes on macOS, and anything under the repo or a scratch directory overflows it
and fails to bind with `ENAMETOOLONG`.

`LA_NEXT_DIST_DIR` matters just as much: two Next servers sharing one build directory corrupt
each other's manifests and wedge with no error output (see `packages/web/lib/dist-lock.ts`).
The suite gets its own tree, so it can never destroy the production `.next` build and never
has to wait for a dev server that holds it.

## How it is wired

- `playwright.config.ts` — headless Chromium, one worker, `reuseExistingServer: false` (a
  stray dashboard would be pointed at your real config dir), trace and screenshot on failure.
  The dashboard is booted through its **package script**: `bun --bun next start`. Launching
  `next` directly re-execs under Node, where every route handler dies with
  `ReferenceError: Bun is not defined`.
- `fixtures/paths.ts` — every path and env var the suite is allowed to use.
- `fixtures/helper-control.ts` — starts/stops the fake helper and talks to its socket from
  Node (`http.request({ socketPath })`). A pid file makes both idempotent, so a spec just
  declares the state it wants: `startHelper()` or `stopHelper()`.
- `fixtures/state.ts` — resets the temp world between tests and reads it back
  (`managedHostnames()`, `readConfig()`, `readClientConfig()`).

The suite runs serially with a single worker by construction: one dashboard, one config file,
one hosts file, one helper socket.

## When something fails

`/tmp/la-e2e` is deliberately left behind. `config/config.json`, `hosts`, `applies.json` and
`helper.log` are the four things worth reading, in that order. Playwright's trace is under
`e2e/test-results/`; open it with `bun run --cwd e2e report` or
`npx playwright show-trace <path>`.
