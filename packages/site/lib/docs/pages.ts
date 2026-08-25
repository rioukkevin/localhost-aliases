/**
 * The docs, as data.
 *
 * Every claim here is checked against the shipped code, not against v1: v2 has no HTTP
 * proxy and no installed daemon, and a doc that says otherwise would be worse than no doc.
 * Sources: docs/V2.md, README.md, packages/core/src/{types,paths}.ts,
 * packages/privileged/apply.sh, packages/mcp/src/server.ts, packages/build/uninstall.sh.
 */
import type { DocPage } from "./schema.ts";

const installation: DocPage = {
  slug: "installation",
  title: "Installation",
  lede: "Build the app from source and put it in /Applications. macOS only.",
  sections: [
    {
      id: "requirements",
      title: "Requirements",
      blocks: [
        {
          kind: "list",
          items: [
            "macOS on Apple Silicon. The app is a Swift menu-bar agent and the privileged work uses `ifconfig`, `dscacheutil` and `/etc/hosts` — none of it is portable.",
            "An arm64 Mac. The Swift tray is compiled with an `arm64-apple-macos13.0` target and there is no universal build, so an Intel Mac produces a binary it cannot run.",
            "[Bun](https://bun.sh) 1.2.5 or later on your `PATH`. The build embeds the very Bun binary it finds there into the bundle.",
            "The Xcode command line tools, for `swiftc`.",
            "`git`, to clone the repository.",
          ],
        },
        {
          kind: "note",
          tone: "info",
          title: "There is no signed download yet",
          text: "No release has been published, and nothing has been code-signed or notarized. The only supported way to get the app today is to build it yourself from the source you can read. When a release does exist, the [changelog](/changelog) lists it with its sha256 so you can verify the file before opening it.",
        },
      ],
    },
    {
      id: "build",
      title: "Build and install",
      blocks: [
        {
          kind: "code",
          label: "clone and build",
          value: "git clone https://github.com/rioukkevin/localhost-aliases.git\ncd localhost-aliases\nbun install\nmake bundle      # builds dist/LocalhostAliases.app\nmake install     # copies it into /Applications",
        },
        {
          kind: "p",
          text: "`make bundle` compiles the Swift tray, builds the dashboard, compiles the forwarder and the MCP server with `bun build --compile`, copies your Bun binary and the privileged script into the bundle, and verifies the bundled dashboard boots. `make install` only copies the result into `/Applications` — it asks for no password and installs no system component.",
        },
        {
          kind: "p",
          text: "Nothing has touched your machine at this point. The first change happens when you launch the app and accept the admin prompt, and the [first run](/docs/first-run) page describes exactly what that prompt does.",
        },
      ],
    },
    {
      id: "launch",
      title: "Launching",
      blocks: [
        {
          kind: "p",
          text: "Open `LocalhostAliases.app` from `/Applications` — or from `~/Applications`, which `make install` falls back to when `/Applications` is not writable, so that it never needs a password either. It is a menu-bar app with no dock icon and no window: the patchbay icon appears in the menu bar, and `Open Dashboard` opens the web UI in your browser.",
        },
        {
          kind: "p",
          text: "Because the build is unsigned, Gatekeeper may refuse the first launch. Right-click the app and choose `Open`, then confirm. That is a decision about a binary you compiled a minute ago from source you can read.",
        },
      ],
    },
    {
      id: "development",
      title: "Running the dashboard for development",
      blocks: [
        {
          kind: "p",
          text: "The dashboard can be run on its own, with nothing installed and no privileges, for development only. In production it is never run outside the app bundle.",
        },
        { kind: "code", label: "development", value: "make dev      # dashboard only\nmake test     # unit tests (bun test)" },
      ],
    },
  ],
};

const firstRun: DocPage = {
  slug: "first-run",
  title: "First run",
  lede: "What the onboarding does, what the one admin prompt changes, and when it comes back.",
  sections: [
    {
      id: "flow",
      title: "The five steps",
      blocks: [
        {
          kind: "p",
          text: "Onboarding runs once at first launch and is re-runnable from Settings. Every step shows its real state, never an optimistic one.",
        },
        {
          kind: "steps",
          items: [
            "**What will change on this Mac.** The exact hostnames, loopback addresses and file paths are listed before anything happens. Nothing has run yet.",
            "**Apply to this Mac.** One macOS admin prompt. This is the only step that needs your password.",
            "**Verify it actually works.** The app fetches `http://index.test` for real and reports what came back, rather than assuming the previous step worked.",
            "**HTTPS for the dashboard** — optional. Generates a local certificate authority and trusts it in your *login* keychain, so `https://index.test` works. This is for the dashboard alone.",
            "**MCP server for your coding agents** — optional. One click installs it into Claude Code or Codex. See [MCP](/docs/mcp).",
          ],
        },
      ],
    },
    {
      id: "prompt",
      title: "What the admin prompt actually does",
      blocks: [
        {
          kind: "p",
          text: "The prompt is raised by `osascript … with administrator privileges` and runs a single script, `packages/privileged/apply.sh`, which ships in the bundle at `Contents/Resources/privileged/apply.sh`. You can read it before you type your password. It takes a desired-state JSON file, is idempotent, and does exactly four things:",
        },
        {
          kind: "steps",
          items: [
            "Adds the loopback addresses your aliases need to `lo0` (`ifconfig lo0 alias 127.0.0.2`), and removes the ones it previously added that are no longer wanted.",
            "Rewrites the managed block in `/etc/hosts`, atomically. Everything outside the markers is preserved byte for byte.",
            "Flushes DNS (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`), so the new names resolve immediately.",
            "Starts the raw TCP forwarder as root, detached, if it is not already running.",
          ],
        },
        {
          kind: "note",
          tone: "info",
          title: "Nothing is permanently installed",
          text: "There is no LaunchDaemon, no `SMAppService`, no privileged helper tool and no `sudo` installer. The only changes to the machine are the `/etc/hosts` block and the `lo0` addresses, and both are reversed by [uninstalling](/docs/uninstalling).",
        },
      ],
    },
    {
      id: "again",
      title: "When the prompt comes back",
      blocks: [
        {
          kind: "table",
          head: ["Action", "Prompts?"],
          rows: [
            ["Add an alias", "Yes — a new hostname and a new loopback address"],
            ["Delete an alias", "Yes — the address and the hosts line come back out"],
            ["Change an alias's target port", "**No.** The forwarder watches its routes file and reloads"],
            ["Rename an alias, or change the TLD", "Yes — every hostname changes"],
            ["Launch after a reboot", "Once, if the reboot cleared the `lo0` addresses"],
            ["Quit the app", "No"],
          ],
        },
        {
          kind: "p",
          text: "A reboot clears `lo0` aliases, so the app checks the live state at launch and only prompts when it has actually drifted from what you configured.",
        },
      ],
    },
    {
      id: "root",
      title: "How a root process is stopped without root",
      blocks: [
        {
          kind: "p",
          text: "The forwarder runs as root, and a normal user process cannot kill root. So the forwarder owns its own lifetime: the app touches a liveness file every 5 seconds, and the forwarder exits by itself once that file has been stale for 15 seconds. Quitting the app is therefore clean, with no second password prompt and nothing left running.",
        },
        {
          kind: "code",
          label: "the heartbeat",
          value: "~/.config/localhost-aliases/liveness",
        },
      ],
    },
  ],
};

const howItWorks: DocPage = {
  slug: "how-aliases-work",
  title: "How aliases work",
  lede: "One loopback IP per alias, one line in /etc/hosts, and a raw TCP forwarder in between.",
  sections: [
    {
      id: "mechanism",
      title: "The mechanism",
      blocks: [
        {
          kind: "p",
          text: "DNS maps a name to an IP address and never to a port. That is the whole problem: `myapp.test` can be made to resolve, but it will resolve to `:80`, not to your dev server's `:3000`. So each alias gets its own loopback address, and a small root process carries port 80 on that address to the port your dev server already listens on.",
        },
        {
          kind: "figure",
          value:
            "  /etc/hosts     127.0.0.2   myapp.test\n  lo0 alias      127.0.0.2\n  forwarder      127.0.0.2:80  ──raw bytes──▶  127.0.0.1:3000",
        },
        {
          kind: "p",
          text: "Your dev server is not touched, restarted or reconfigured. It keeps listening on `127.0.0.1:3000` exactly as before; the alias is an addition, not a replacement, and `http://localhost:3000` keeps working.",
        },
      ],
    },
    {
      id: "raw-tcp",
      title: "Raw bytes, not HTTP",
      blocks: [
        {
          kind: "p",
          text: "The forwarder splices sockets. It parses nothing — no `Host` header, no header rewriting, no hop-by-hop rules. That is the KISS choice, and it has consequences worth knowing:",
        },
        {
          kind: "list",
          items: [
            "WebSockets and HMR work for free. Passthrough does not care what the bytes are.",
            "Any protocol works, not just HTTP.",
            "There is no proxy in the request path to misinterpret anything, because there is no proxy.",
          ],
        },
        {
          kind: "note",
          tone: "info",
          title: "https:// is optional, and off by default",
          text: "Aliases always answer on `http://`. Turn https on in Settings and they answer on `https://` too, without losing `http://`. Terminating TLS is possible despite the raw splice because each alias owns its own loopback address: a listener on `127.0.0.3:443` identifies the alias from the address, so it presents that certificate without parsing a `Host` header or inspecting SNI. The certificate is issued and renewed for you; telling your Mac to trust the authority that signed it is the one manual step, because macOS asks for your keychain password. Firefox uses its own certificate store and needs that step separately.",
        },
      ],
    },
    {
      id: "addresses",
      title: "Loopback addresses",
      blocks: [
        {
          kind: "p",
          text: "Addresses are allocated from `127.0.0.2` to `127.0.0.254`. `127.0.0.1` is never used — it is the real loopback, and your dev server is on it. The lowest free address is assigned when an alias is created and stays with that alias for life, so a name never silently moves.",
        },
        {
          kind: "p",
          text: "253 aliases is the hard ceiling, being the size of the pool. The dashboard says so if you ever reach it.",
        },
      ],
    },
    {
      id: "hosts",
      title: "The /etc/hosts block",
      blocks: [
        {
          kind: "p",
          text: "All managed entries live between two markers. Everything outside them — including anything you added yourself — is preserved byte for byte, and the file is written atomically.",
        },
        {
          kind: "code",
          label: "/etc/hosts",
          value:
            "# >>> localhost-aliases >>>\n127.0.0.2\tindex.test\n127.0.0.3\tmyapp.test\n127.0.0.4\tapi.myapp.test\n# <<< localhost-aliases <<<",
        },
        {
          kind: "p",
          text: "Those markers are the uninstall contract. If you ever need to recover by hand, deleting the block between them removes every alias — see [troubleshooting](/docs/troubleshooting).",
        },
      ],
    },
    {
      id: "reserved",
      title: "index.test, the reserved alias",
      blocks: [
        {
          kind: "p",
          text: "`index.test` is always present and maps to the dashboard itself, so `Open Dashboard` opens a name rather than a port number. It cannot be renamed or deleted from the UI. The dashboard is embedded in the app bundle and listens on `127.0.0.1:7788` by default; it only answers while the app is running.",
        },
      ],
    },
    {
      id: "tld",
      title: "The TLD: .test",
      blocks: [
        {
          kind: "p",
          text: "Every alias ends in `.test`. [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.2) reserves that suffix for development: it is never delegated to a registry, never publicly resolvable, and nothing on macOS claims it — so the line in `/etc/hosts` is the answer, immediately. Changing the TLD renames every hostname, so the next apply needs one admin prompt.",
        },
        {
          kind: "note",
          tone: "warn",
          title: ".local is not supported",
          text: "`.local` is reserved for multicast DNS by [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762#section-3), and on macOS `mDNSResponder` owns it: a lookup is put to the network as a multicast query and the resolver waits that query out. On the machine this was measured on, that wait is about five seconds per name — the same five seconds whether or not the name is in `/etc/hosts`, which is what proves the suffix is the cost rather than anything the app writes. So `.local` is rejected rather than offered. It is not broken: Bonjour resolves the names it actually owns quickly, which is what it is for. It is the wrong carrier for a name whose answer is a static line in a file.",
        },
        {
          kind: "p",
          text: "Reproduce it yourself: time `getaddrinfo` for a `.local` name that exists nowhere, and for a `.test` name that exists nowhere. The first waits, the second returns in microseconds.",
        },
        {
          kind: "code",
          label: "time getaddrinfo",
          value:
            "bun -e '\nconst dns = require(\"node:dns\");\nfor (const n of [\"nope-xyz.local\", \"nope-xyz.test\"]) {\n  const t = Bun.nanoseconds();\n  await new Promise((r) => dns.lookup(n, () => r()));\n  console.log(n.padEnd(16), ((Bun.nanoseconds() - t) / 1e9).toFixed(3) + \"s\");\n}'",
        },
        {
          kind: "figure",
          value: "nope-xyz.local   5.006s\nnope-xyz.test    0.003s",
          caption: "macOS 26.3, Apple Silicon — neither name is in /etc/hosts",
        },
        {
          kind: "note",
          tone: "warn",
          title: "HSTS-preloaded TLDs are rejected too",
          text: "`.dev`, `.app`, `.page` and the other TLDs on the browsers' [HSTS preload list](https://hstspreload.org) are upgraded from `http://` to `https://` by Chrome and Safari before a request ever leaves the machine. Project aliases are `http://` only — the forwarder never parses the traffic, so nothing can present a certificate — which means an alias under one of those TLDs would fail with a TLS error that says nothing about the real cause. Validation refuses them with that reason instead. The last label is what decides, so `foo.dev` is refused exactly as `dev` is.",
        },
        {
          kind: "p",
          text: "`.localhost` is refused for a third reason: macOS resolves every name under it to `127.0.0.1` on its own and never reads `/etc/hosts`, so the name would land past the forwarder on a port nothing is listening on.",
        },
        {
          kind: "p",
          text: "Settings offers `test`, `internal`, `lan`, `home.arpa` and `example` as quick picks, and you can type another. A refused suffix is refused inline, with the specific reason it fails rather than a flat “not allowed”.",
        },
      ],
    },
    {
      id: "state",
      title: "Where state lives",
      blocks: [
        {
          kind: "table",
          head: ["Path", "What it is"],
          rows: [
            ["`~/.config/localhost-aliases/config.json`", "your aliases, TLD and dashboard port"],
            ["`~/.config/localhost-aliases/desired-state.json`", "what the privileged script is asked to make true"],
            ["`~/.config/localhost-aliases/routes.json`", "what the forwarder watches; a port edit rewrites this and nothing else"],
            ["`~/.config/localhost-aliases/forwarder-status.json`", "what the root forwarder reports, readable without privileges"],
            ["`~/.config/localhost-aliases/liveness`", "the heartbeat that keeps the root forwarder alive"],
            ["`~/Library/Logs/localhost-aliases/`", "logs, including every privileged run"],
            ["`/etc/hosts`", "the managed block, between the markers above"],
          ],
        },
      ],
    },
  ],
};

const projects: DocPage = {
  slug: "projects",
  title: "Projects",
  lede: "Group aliases by folder, and optionally pin them in the repo with .localhost-aliases.json.",
  sections: [
    {
      id: "folders",
      title: "Linking a folder",
      blocks: [
        {
          kind: "p",
          text: "An alias can carry an absolute project folder path. That is all a project is: aliases that share a folder are grouped under it in the patchbay, and the Projects view lists the folders that have at least one alias. An alias with no folder is perfectly normal — it simply belongs to nothing.",
        },
        {
          kind: "p",
          text: "Linking a folder is metadata only. It writes no file into your repository and needs no admin prompt.",
        },
      ],
    },
    {
      id: "workspace-file",
      title: "The optional .localhost-aliases.json",
      blocks: [
        {
          kind: "p",
          text: "A repository can declare the aliases it wants, so a teammate can recreate them in one action instead of reading a README. The file is entirely optional — aliases created in the dashboard work perfectly well without it — and it never creates anything on its own.",
        },
        {
          kind: "code",
          label: ".localhost-aliases.json",
          value:
            '{\n  "aliases": [\n    { "name": "myapp", "port": 3000, "description": "web" },\n    { "name": "api.myapp", "port": 3001, "description": "API" }\n  ]\n}',
        },
        {
          kind: "list",
          items: [
            "`name` — the host label without the TLD. Lowercase letters, digits, hyphens and dots.",
            "`port` — the port your dev server listens on, on `127.0.0.1`.",
            "`description` — optional, shown in the dashboard.",
          ],
        },
        {
          kind: "p",
          text: "Importing a declared alias that does not exist yet creates one, which changes the hostname set — so that import is one of the actions that raises the admin prompt.",
        },
      ],
    },
    {
      id: "agents",
      title: "From a coding agent",
      blocks: [
        {
          kind: "p",
          text: "The MCP server exposes the same operations: `list_projects` lists the linked folders, and `link_project` attaches a folder to an alias, imports the aliases the folder declares, and can write the file back out from the aliases currently linked to it. See [MCP](/docs/mcp).",
        },
      ],
    },
  ],
};

const mcp: DocPage = {
  slug: "mcp",
  title: "MCP server",
  lede: "Let Claude Code or Codex see which URL belongs to which project, and register new ones.",
  sections: [
    {
      id: "install",
      title: "One-click install",
      blocks: [
        {
          kind: "p",
          text: "The last onboarding step — also available any time from Settings — installs the stdio MCP server into Claude Code or Codex in one click. It edits only that client's config file, preserves every other key, and refuses rather than overwrites if the file is not valid JSON.",
        },
        {
          kind: "table",
          head: ["Client", "Config file", "Format"],
          rows: [
            ["Claude Code", "`~/.claude.json`", "a `mcpServers.localhost-aliases` entry"],
            ["Codex", "`~/.codex/config.toml`", "an `[mcp_servers.localhost-aliases]` table"],
          ],
        },
        {
          kind: "p",
          text: "If you would rather paste it yourself, the same screen shows the exact snippet. In an installed app the server is a compiled binary inside the bundle and runs directly; in a git checkout it is a TypeScript entry point run by Bun, so the command differs between the two and the UI shows the one that applies to you.",
        },
        {
          kind: "code",
          label: "~/.codex/config.toml (installed app)",
          value:
            '[mcp_servers.localhost-aliases]\ncommand = "/Applications/LocalhostAliases.app/Contents/Resources/mcp"\nargs = []',
        },
      ],
    },
    {
      id: "tools",
      title: "What the agent can do",
      blocks: [
        {
          kind: "table",
          head: ["Tool", "What it does", "Prompts?"],
          rows: [
            ["`list_aliases`", "every alias with its hostname, target port, loopback IP and live status", "No"],
            ["`list_projects`", "the folders that have at least one alias linked", "No"],
            ["`create_alias`", "creates `http://<name>.<tld>` pointing at `127.0.0.1:<port>`", "**Yes**"],
            ["`delete_alias`", "removes an alias by hostname, name or id", "**Yes**"],
            ["`link_project`", "attaches a folder, imports its declared aliases", "Only if it creates one"],
            ["`get_usage_instructions`", "the full mechanism, so the agent explains it correctly", "No"],
          ],
        },
        {
          kind: "note",
          tone: "warn",
          title: "The agent cannot approve the prompt for you",
          text: "`create_alias` and `delete_alias` raise the macOS admin prompt that you must accept in person. The server's own instructions tell the model not to call them speculatively.",
        },
      ],
    },
    {
      id: "running",
      title: "It needs the app running",
      blocks: [
        {
          kind: "p",
          text: "The MCP server is a thin client of the dashboard's HTTP API on `127.0.0.1:7788`, and the dashboard is embedded in the menu-bar app. If a tool reports the dashboard is unreachable, the fix is to open Localhost Aliases — not to retry.",
        },
        {
          kind: "p",
          text: "The server is also told, in its own instructions, that project aliases are `http://` only, so your agent should never suggest `https://myapp.test`.",
        },
      ],
    },
  ],
};

const uninstalling: DocPage = {
  slug: "uninstalling",
  title: "Uninstalling",
  lede: "One admin prompt reverses every change. Nothing is left behind.",
  sections: [
    {
      id: "how",
      title: "How",
      blocks: [
        {
          kind: "p",
          text: "Quit the app from the menu bar first — the uninstaller refuses to run while it is up — then run:",
        },
        { kind: "code", label: "uninstall", value: "make uninstall   # one admin prompt" },
        {
          kind: "p",
          text: "There is a menu item for the same thing. The privileged half is a single script, `packages/privileged/uninstall.sh`, run behind one prompt; the uninstaller prefers the copy inside the installed bundle, because that is the one that was used.",
        },
      ],
    },
    {
      id: "what",
      title: "What it removes",
      blocks: [
        {
          kind: "steps",
          items: [
            "Stops the root forwarder.",
            "Removes the `lo0` addresses it added.",
            "Strips the managed block from `/etc/hosts`, leaving every other line untouched.",
            "Flushes DNS.",
            "Removes the local CA from your login keychain — matched by SHA-1 fingerprint, never by name, because deleting the wrong certificate is unrecoverable.",
            "Deletes `~/.config/localhost-aliases`.",
            "Deletes the app.",
          ],
        },
        {
          kind: "p",
          text: "Your projects are untouched, any `.localhost-aliases.json` files stay in their repositories, and `/etc/hosts` keeps every line outside the managed block. If the privileged half fails, nothing is deleted — you can fix the problem and run it again.",
        },
      ],
    },
  ],
};

const troubleshooting: DocPage = {
  slug: "troubleshooting",
  title: "Troubleshooting",
  lede: "What to check when a name does not resolve, and how to undo everything by hand.",
  sections: [
    {
      id: "not-resolving",
      title: "A name does not resolve",
      blocks: [
        {
          kind: "p",
          text: "Work down this list. Each step tells you which of the three moving parts is missing.",
        },
        {
          kind: "steps",
          items: [
            "**Is the app running?** The forwarder exits by itself when the app stops, so `myapp.test` resolves but nothing answers. Look for the patchbay icon in the menu bar.",
            "**Is the hosts entry there?** `grep -A20 'localhost-aliases' /etc/hosts` should show your hostname inside the marker block.",
            "**Is the address on lo0?** `ifconfig lo0 | grep 'inet 127.0.0'` should list the alias's address. A reboot clears these; relaunching the app re-adds them behind one prompt.",
            "**Is anything listening on the target port?** `curl -sv http://127.0.0.1:3000` — if that fails, the alias is fine and your dev server is not up.",
            "**Is DNS cached?** `sudo dscacheutil -flushcache` and `sudo killall -HUP mDNSResponder`. The app does this for you after every apply, but a browser keeps its own cache too.",
          ],
        },
        {
          kind: "code",
          label: "the one-line check",
          value: "curl -sv http://myapp.test 2>&1 | head -20",
        },
      ],
    },
    {
      id: "listening",
      title: "It resolves, but the browser gets nothing",
      blocks: [
        {
          kind: "p",
          text: "The forwarder connects to `127.0.0.1:<port>` specifically. A dev server bound only to IPv6 `::1`, or only to an external interface, will not be reachable — bind it to `127.0.0.1` or `0.0.0.0`. `lsof -nP -iTCP:3000 -sTCP:LISTEN` shows which address it actually took.",
        },
        {
          kind: "p",
          text: "If the dashboard shows `no server` for an alias, that is exactly this: the name and the address are in place, and nothing is listening on the port behind them.",
        },
      ],
    },
    {
      id: "https",
      title: "https:// does not work",
      blocks: [
        {
          kind: "p",
          text: "It cannot, for project aliases, and this is not a bug to be fixed. The forwarder moves raw bytes and never sees the traffic, so there is nothing there that could terminate TLS. Use `http://`. `https://` is available for the dashboard alone. See [how aliases work](/docs/how-aliases-work).",
        },
      ],
    },
    {
      id: "rejected-tld",
      title: "The TLD I typed was rejected",
      blocks: [
        {
          kind: "p",
          text: "Three families of TLD are refused, each for a specific reason rather than a preference. The default, `.test`, is reserved for development by RFC 6761 and has none of these problems — see [how aliases work](/docs/how-aliases-work#tld).",
        },
        {
          kind: "list",
          items: [
            "`.local` — reserved for mDNS/Bonjour, and on macOS `mDNSResponder` owns it. Every lookup waits out a multicast query first: about five seconds per name, whether or not the name is in `/etc/hosts`. A dev URL that takes five seconds to resolve is not usable, so the app does not offer the suffix.",
            "`.dev`, `.app`, `.page` and the rest of the HSTS preload list — Chrome and Safari rewrite `http://` to `https://` for these before the request leaves the machine. Project aliases are `http://` only, so the browser would show a TLS error instead of your app.",
            "`.localhost` — macOS answers this suffix itself, always `127.0.0.1`, without reading `/etc/hosts`. Each alias has its own `127.0.0.x`, so the name would never reach it.",
          ],
        },
        {
          kind: "p",
          text: "Settings offers `test`, `internal`, `lan`, `home.arpa` and `example`, and accepts anything else that is not on those three lists. Changing the TLD renames every hostname, so the next apply raises the admin prompt once.",
        },
      ],
    },
    {
      id: "by-hand",
      title: "Recovering by hand",
      blocks: [
        {
          kind: "p",
          text: "If the app is gone, broken, or you simply do not trust it any more, you can undo everything yourself. Two things were changed and both are visible.",
        },
        {
          kind: "steps",
          items: [
            "Open `/etc/hosts` as root (`sudo nano /etc/hosts`) and delete everything from `# >>> localhost-aliases >>>` to `# <<< localhost-aliases <<<`, markers included. Nothing outside that block was ever ours.",
            "Remove each loopback address the app added: `sudo ifconfig lo0 -alias 127.0.0.2`, once per address. `ifconfig lo0` lists them; `127.0.0.1` is the real loopback and must stay.",
            "Flush DNS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.",
            "Delete the app from `/Applications` and, if you want the state gone too, `rm -rf ~/.config/localhost-aliases`.",
          ],
        },
        {
          kind: "note",
          tone: "danger",
          title: "The forwarder is running as root",
          text: "It exits on its own within 15 seconds of the app no longer touching `~/.config/localhost-aliases/liveness` — quitting or deleting the app is enough. Deleting that file has the same effect. You do not need to hunt for a process to kill.",
        },
        {
          kind: "p",
          text: "The `lo0` addresses do not survive a reboot either, so a restart clears half of this for you.",
        },
      ],
    },
    {
      id: "logs",
      title: "Logs",
      blocks: [
        {
          kind: "p",
          text: "Every privileged run appends to `~/Library/Logs/localhost-aliases/privileged.log`, including the exact step that failed. The forwarder's own view of the world is in `~/.config/localhost-aliases/forwarder-status.json`, which is written so the UI can read real state without asking for privileges.",
        },
      ],
    },
  ],
};

/** Navigation order. This is the reading order, not alphabetical. */
export const DOC_PAGES: DocPage[] = [
  installation,
  firstRun,
  howItWorks,
  projects,
  mcp,
  uninstalling,
  troubleshooting,
];

export function getDocPage(slug: string): DocPage | null {
  return DOC_PAGES.find((page) => page.slug === slug) ?? null;
}
