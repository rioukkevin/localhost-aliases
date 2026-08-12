/**
 * The transparency doc.
 *
 * This is a product requirement, not a nicety: an agent (and through it, a user)
 * must be able to know exactly what this server changes on the machine before it
 * calls a single tool. `serverInstructions()` is handed to the client at
 * `initialize`; `usageInstructions()` is the long form behind
 * `get_usage_instructions`. Both are plain text, written for a coding agent that
 * has never seen the tool before.
 *
 * Every filesystem path below comes from `livePaths()`, never from a literal — the
 * whole point of this text is to name the files that will actually change.
 */
import { HOSTS_BEGIN, HOSTS_END, WORKSPACE_FILENAME } from "@localhost-aliases/core";
import { livePaths } from "./paths.ts";

/** Short form: sent in the `instructions` field of the initialize response. */
export function serverInstructions(): string {
  const path = livePaths();
  return `localhost-aliases gives a local dev server a real hostname: myapp.local instead of
localhost:3000. The dev server itself is not changed in any way — it keeps listening
on the same port.

How it actually works (two moving parts, both local to this Mac):
  1. Name resolution — a managed block in ${path.hosts}, delimited by
     "${HOSTS_BEGIN}" / "${HOSTS_END}", maps each hostname to 127.0.0.1.
     That block is written by a small root helper daemon; nothing outside the two
     markers is ever touched. The DNS cache is flushed afterwards.
  2. Port routing — the same helper runs a reverse proxy, reads the Host header, and
     forwards the request to the matching local port. It serves plain HTTP (port 80
     by default) and, when HTTPS is enabled, TLS as well (port 443 by default) with a
     certificate issued by a local CA kept in ${path.ca}. Both ports are
     settings in the dashboard. While HTTPS is on, the URL reported for each alias is
     the https:// one.

What creating an alias changes on this machine:
  - one line inside the managed block of ${path.hosts} (root helper, atomic write)
  - the config file ${path.config}
  - the local DNS cache is flushed
What it never changes: your source code, package.json, .env, dev-server config or ports,
anything outside the ${path.hosts} markers, and anything off this machine. No remote DNS,
no deployment, no outbound traffic.

An alias may optionally record the project folder it belongs to (projectPath). That is only
a grouping stored in the config file — no file in that folder is read or written for it.
The per-project file ${WORKSPACE_FILENAME} is entirely OPTIONAL. It is a committed record
of "this repo expects these names"; aliases work identically without it and nothing reads
it at runtime. Only link_project writes it, and only for the path you pass.

How to pick an alias: call list_aliases FIRST. Reuse an alias that already points at your
dev port or already belongs to this project folder — do not create duplicates. Only call
create_alias when nothing matches, and prefer asking the user first, because it edits
${path.hosts}. A hostname that was never registered will not resolve, so never write one
into code or docs without creating it here.

These tools are thin clients of the localhost-aliases dashboard API at ${path.dashboard};
if that app is not running, every tool will say so and how to start it.
Call get_usage_instructions for the full version, including the workspace file format.`;
}

/** Long form: returned by the `get_usage_instructions` tool. */
export function usageInstructions(): string {
  const path = livePaths();
  return `# localhost-aliases — what it is, what it touches, how to use it

## The problem it solves

DNS maps names to IP addresses, never to ports. So "myapp.local" cannot, on its own, mean
"127.0.0.1 port 3000". localhost-aliases closes that gap with two local pieces:

1. **Name resolution.** A managed block in ${path.hosts}, between the markers
   "${HOSTS_BEGIN}" and "${HOSTS_END}", maps every alias hostname to 127.0.0.1.
   The block is rewritten atomically by a small root helper daemon
   (dev.localhost-aliases.helper). Everything outside the two markers is preserved
   byte-for-byte. After a change the DNS cache is flushed
   (dscacheutil -flushcache, killall -HUP mDNSResponder).
2. **Port routing.** The same helper owns the proxy ports — 80 for HTTP and 443 for
   HTTPS by default, both configurable in the dashboard's settings. It reads the Host
   header of each incoming request and reverse-proxies it to the local port registered
   for that hostname. WebSocket upgrades are proxied too, so HMR keeps working.

Your dev server is untouched. It keeps listening on 127.0.0.1:3000 exactly as before; the
proxy is what makes myapp.local reach it.

## HTTP and HTTPS

Plain HTTP is always served. When HTTPS is enabled in the dashboard, the helper additionally
binds a TLS listener with one certificate whose SANs cover every alias hostname, issued by a
local certificate authority stored in ${path.ca}. That CA is generated once, on this
machine, and never leaves it. Trusting it (so the browser stops warning) is a separate,
explicit step the user performs themselves; the dashboard shows the exact command.

While HTTPS is enabled, the \`url\` reported for each alias by list_aliases is the https://
one — use that when you write the address anywhere. Turning HTTPS off stops the TLS listener
and the URLs go back to http://; plain HTTP keeps working either way.

## Exactly what changes on this machine

Creating, editing or deleting an alias changes:
  - the managed block of ${path.hosts} (only between the markers above)
  - ${path.config} — the alias list
  - the macOS DNS cache (flushed so the new name resolves immediately)
Enabling HTTPS additionally creates the local certificate authority under ${path.ca}.
Calling link_project additionally writes ${WORKSPACE_FILENAME} in the folder you name.

It never changes:
  - your source code, package.json, .env, framework config or dev-server port
  - any part of ${path.hosts} outside the two markers
  - any other machine, any DNS server, anything on the network — every alias resolves to
    127.0.0.1 and traffic never leaves this Mac
  - system settings, login items, or your shell profile
Deleting an alias removes its line from the managed block and its route; nothing else is
left behind.

## Choosing between an existing alias and a new one

1. Call **list_aliases** first. Every alias comes back with its hostname, URL, port,
   project folder and live status.
2. Reuse rather than create when any of these is true:
   - an alias already points at the port your dev server uses
   - an alias' projectPath is the folder you are working in
   - the project's ${WORKSPACE_FILENAME} (see below, or call list_projects) names it
3. Create only when nothing matches. Prefer a name derived from the project folder
   ("acme-shop" -> acme-shop.local). Because create_alias edits ${path.hosts} through a
   root helper, ask the user before doing it unless they clearly asked for an alias.
4. Never reference a hostname in code, docs or a README unless it exists here — an
   unregistered name simply does not resolve.
5. Names are validated: lowercase letters, digits and hyphens, dot-separated labels, and
   "localhost" / "local" / "broadcasthost" are reserved. Ports are 1-65535 and must be
   free of conflicts with other aliases.

## Using an alias in a project

Start the dev server on its normal port, then open the alias URL. If the alias exists but
nothing is listening yet, the proxy serves a self-refreshing "nothing is listening on
:3000" page instead of an error — it becomes your app as soon as the server boots. That is
also what a "down" status in list_aliases means: the alias is fine, the port is idle.

An alias can optionally carry a projectPath, the absolute folder it belongs to. It is a
label used for grouping in the dashboard and in list_projects; nothing in that folder is
read or written because of it.

Frameworks that check the Host header may need it allowed (for example Vite's
server.allowedHosts, or Next.js allowedDevOrigins). That is a change in your project, so it
is yours to make — this server will not edit your config.

## The workspace file is OPTIONAL

${WORKSPACE_FILENAME}, in a project root:

    {
      "$schema": "https://localhost-aliases.dev/schema/workspace-v1.json",
      "aliases": [
        { "name": "acme-shop", "port": 3000, "description": "storefront" },
        { "name": "acme-api", "port": 4000 }
      ]
    }

It is a committed, human-readable record of the names a repo expects, so a teammate (or an
agent) can recreate them. Nothing reads it at runtime; aliases work exactly the same
without it. A project with no such file is completely normal, never an error. Only
link_project writes it, only in the directory you pass, and it merges — unknown keys and
alias entries you already had are preserved.

## Tools

  list_aliases            every alias: hostname, url, port, project, live status
  list_projects           folders with aliases attached, and whether each has a
                          ${WORKSPACE_FILENAME}
  create_alias            { name, port, projectPath?, description? }
  delete_alias            { name } or { id }
  link_project            { path, aliases[] } — merges the workspace file and registers
                          the aliases in one step
  get_usage_instructions  this document
Resource: localhost-aliases://aliases — the same alias list as JSON.

## When something is not working

- "dashboard is not running": these tools talk to the localhost-aliases app over HTTP at
  ${path.dashboard}. Start the menu-bar app, or run \`bun run dev\` in the
  localhost-aliases repo, and retry.
- Aliases saved but the hostname does not resolve: the privileged helper is not installed
  or not running, so ${path.hosts} was never written. The dashboard shows the exact command
  (\`sudo ./scripts/install.sh\`). Installing it is a deliberate, user-run step — this
  server will never run sudo for you.`;
}
