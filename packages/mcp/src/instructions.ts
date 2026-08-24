/**
 * What the model is told about this server. Written to be honest about the mechanism
 * and its one real limitation (no TLS for project aliases), because a wrong mental
 * model here produces confidently wrong advice to the user.
 *
 * Every path is read from core's paths module — nothing is hardcoded, so the text is
 * correct in a checkout and in the built .app alike.
 */
import { HOSTS_PATH, configDir, dashboardUrl, runtimeLayout } from "@localhost-aliases/core/paths";
import { DEFAULT_TLD, WORKSPACE_FILENAME } from "@localhost-aliases/core/types";

export function mechanismSummary(): string {
  const layout = runtimeLayout();
  return `# How a localhost alias actually works

An alias turns \`http://myapp.${DEFAULT_TLD}\` into a dev server on \`127.0.0.1:3000\`. DNS maps a name
to an IP and never to a port, so three things are needed and all three are visible on disk:

1. A loopback IP is allocated to the alias for life, from 127.0.0.2 to 127.0.0.254, and added
   to lo0 (\`ifconfig lo0 alias 127.0.0.2\`).
2. A line \`127.0.0.2  myapp.${DEFAULT_TLD}\` is written into a clearly marked managed block in
   ${HOSTS_PATH}. Everything outside that block is preserved byte for byte.
3. A small TCP forwarder runs as root and splices \`127.0.0.2:80\` to \`127.0.0.1:3000\`.

Those are the only changes made to the machine, and all of them are reversible.

## Privileges

There is no installed daemon, no LaunchDaemon and no sudo. All privileged work is one
idempotent batch behind a single macOS admin prompt, run from:
  ${layout.applyScript}
Adding or removing an alias changes the hostname/IP set and therefore prompts once.
Changing only the target port does NOT prompt: the forwarder watches its routes file and
reloads. So port edits are cheap; creating and deleting aliases are not.

The forwarder runs as root but cannot outlive the app: it watches a liveness file the app
touches, and exits on its own when the app stops.

## Limitations, stated plainly

- Project aliases are **http:// only**. The forwarder moves raw bytes and never sees the
  traffic, so it cannot terminate TLS. Never tell the user to try https://myapp.${DEFAULT_TLD}.
  (https:// can be offered for the dashboard alone, because we run that server ourselves.)
- Because it is raw TCP and not an HTTP proxy, WebSockets, HMR and non-HTTP protocols all
  pass through untouched. No Host header rewriting happens, and none is needed.
- Aliases listen on port 80 of their own loopback IP. The dev server itself keeps listening
  on 127.0.0.1:<port>; the alias is an addition, not a replacement.
- 253 aliases is the hard ceiling (the size of the loopback pool).
- \`index.${DEFAULT_TLD}\` is reserved: it serves this dashboard and cannot be renamed or deleted.
- macOS only.

## State on disk

- config, desired state, routes and forwarder status: ${configDir()}
- managed block: ${HOSTS_PATH}
- optional per-project file: ${WORKSPACE_FILENAME} in the project root. It is genuinely
  optional — aliases work without it. It exists so a repo can declare the aliases it wants
  and a teammate can recreate them; it never creates anything on its own.

## This MCP server

It is a thin client of the dashboard's HTTP API at ${dashboardUrl()}. The dashboard is
embedded in the Localhost Aliases menu-bar app and only answers while that app is running.
If a tool reports the dashboard is unreachable, the fix is to open the app — not to retry.`;
}

export function serverInstructions(): string {
  return `Manage localhost aliases (${dashboardUrl()}) on macOS: memorable hostnames like
http://myapp.${DEFAULT_TLD} that reach a dev server on 127.0.0.1:<port>.

Use list_aliases before creating one — names must be unique and the tool will refuse a
duplicate. Use create_alias when the user wants a hostname for a running dev server; it
triggers one macOS admin prompt that the user must accept, so do not call it speculatively.
delete_alias also prompts. Changing a port does not.

Project aliases are http:// only — never suggest https:// for them.

Call get_usage_instructions when you need the full mechanism, the exact files touched, or
how to explain to the user what is about to change on their machine.`;
}
