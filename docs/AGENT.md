# Root agent, offline page, stack detection — contract

Three changes, one theme: stop asking for the password on every edit, and tell the user
something useful when their dev server is not running.

## 1. The root agent (replaces per-change prompts)

Today every hostname/IP change raises an admin prompt. That is honest but unusable at the rate
people add aliases. New model:

- **One admin prompt at app launch.** It starts a long-lived root process — the *agent*.
- The agent **watches `desiredStatePath()`**. When the file changes it reconciles: `lo0`
  aliases, the `/etc/hosts` managed block, a DNS flush, and the forwarder routes. No prompt.
- The agent **is** the forwarder. One root process, not two: it already exists, already runs as
  root, and already self-terminates. Adding reconciliation to it is strictly fewer moving parts
  than a second privileged process with a second heartbeat.
- It **exits on its own** when `livenessPath()` goes stale (`LIVENESS_TIMEOUT_MS`), exactly as
  the forwarder does now. Quitting the app must still leave nothing running as root.
- Nothing is installed. No LaunchDaemon, no plist, no SMAppService. Uninstall stays: stop the
  app, strip the hosts block, drop the lo0 addresses.

### The security tradeoff, stated plainly

`desired-state.json` is writable by the user, and a root process acts on it. Any process running
as this user can therefore ask root to edit `/etc/hosts` and add loopback addresses. That is a
real local privilege escalation and must be documented in the README, the site's security copy
and `packages/privileged/README.md` — not buried.

It is bounded by validation the agent performs **itself**, never trusting the file:
- hostnames re-validated against the same rules as `isValidHostname`, rejecting whitespace, `#`,
  newlines, over-long labels and reserved names;
- IPs restricted to the `127.0.0.2`–`127.0.0.254` pool; `127.0.0.1` is never touched, and an
  address the agent did not allocate is never removed;
- `/etc/hosts` edits confined to the marker block, written atomically, refusing to write if a
  byte outside the markers would change;
- forward targets restricted to loopback.

A malformed or hostile file must be rejected with a logged reason, leaving the previous state.

## 2. Offline page (the dev server is not running)

v1 served this from an HTTP proxy. v2 forwards raw bytes and cannot speak HTTP — that is why the
page disappeared. It comes back **only on the failure path**, so the working path stays pure
passthrough:

- On **upstream connect failure only**, peek at the first bytes of the client connection.
- If they start with an HTTP method token (`GET `, `POST `, `HEAD `, …), write a self-contained
  HTTP 503 response and close. Otherwise close without writing — it is not HTTP and inventing a
  response would corrupt someone's protocol.
- The page keeps the alias URL in the address bar (no redirect), is inline-CSS only, dark/light
  aware via `prefers-color-scheme`, and matches `docs/DESIGN.md`.
- It states the alias, the port nothing is listening on, and — when known — the exact command to
  start that project on that port (see stack detection). It auto-reloads, so it becomes the real
  app the moment the server boots. Respect `prefers-reduced-motion` for any spinner.
- It links to the dashboard's fuller page: `http://index.<tld>/offline?host=<hostname>`.

`Route` gains an optional hint so the root agent can render instructions without reading the
user's project folders itself:

```ts
export interface Route {
  ip: string; listenPort: number; targetPort: number; hostname: string;
  hint?: { framework: string; command: string };   // NEW, optional
}
```

## 3. Stack detection

`packages/core/src/stack.ts`, pure and read-only:

```ts
export interface DetectedStack { framework: string; command: string; confidence: "high" | "low"; }
export async function detectStack(dir: string): Promise<DetectedStack | null>;
```

- Reads `package.json` (deps and scripts) and lockfiles; recognises at least Next, Vite, Astro,
  Remix, Nuxt, SvelteKit, CRA, Rails, Django, Laravel and a plain static server.
- Returns the command that pins the port, e.g. `next dev -p 3000`, `vite --port 3000`,
  `rails s -p 3000`, `python manage.py runserver 3000`.
- **Reads only. Never executes anything, never writes into the user's repository.** The user
  explicitly declined the write-into-config option.
- A folder it does not recognise returns `null`, and the UI says so plainly rather than guessing.

Surfaced on the project card, on the offline page, and on the dashboard's `/offline` route.

## 4. Launch at login

`SMAppService.mainApp.register()` (macOS 13+), toggled from the settings drawer, reflecting real
`SMAppService.Status` rather than an optimistic boolean. Be honest in the copy: with the root
agent model, launching at login means **one admin prompt per login**. A user who dislikes that
should be told before they enable it, not after.

## 5. Already exists — verify, do not rebuild

`UnassignedList` on the home dashboard already has a create form ("Patch it") for aliases with no
project. If it is not usable, the bug is discoverability or a defect in that component — diagnose
it before writing anything new.
