/**
 * The FAQ, as data — the same block model the docs use, so it renders through the same
 * renderer and can be unit-tested rather than only looked at.
 *
 * EVERY CLAIM HERE WAS CHECKED AGAINST THE SHIPPED CODE, not against memory. An FAQ that
 * reassures with something untrue is worse than no FAQ. Sources, per answer:
 *
 *   /etc/hosts vs ports      docs/V2.md "The mechanism"; packages/core/src/{hosts,ips}.ts
 *   what runs as root        docs/AGENT.md §1; packages/forwarder/src/agent.ts;
 *                            packages/privileged/apply.sh; packages/core/src/paths.ts
 *                            (LIVENESS_TOUCH_MS 5s, LIVENESS_TIMEOUT_MS 15s)
 *   http:// only             docs/V2.md; packages/forwarder/src/splice.ts (raw bytes)
 *   .test vs .local          docs/TLD.md (the measured table is copied from it verbatim)
 *   HMR / WebSockets         docs/V2.md; packages/forwarder/src/forwarder.ts
 *   reboot                   docs/AGENT.md §1 and §4; apps/tray/Sources/LoginItem*.swift
 *   uninstall                packages/privileged/{uninstall,teardown,self-delete}.sh
 *   phone home               no outbound host appears anywhere in the app's source
 *   signing                  packages/build/sign.sh, install-local.sh; no release exists
 *   Apple Silicon            apps/tray/Makefile `-target arm64-apple-macos13.0`; Info.plist
 */
import type { DocBlock } from "./docs/schema.ts";

export interface FaqItem {
  /** Anchor id, so an answer can be linked to directly. */
  id: string;
  question: string;
  blocks: DocBlock[];
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "why-not-edit-hosts",
    question: "Why not just edit /etc/hosts myself?",
    blocks: [
      {
        kind: "p",
        text: "You can, and it gets you half way. `/etc/hosts` maps a name to an **IP address** — it has no concept of a port. So a line reading `127.0.0.1 myapp.test` sends `http://myapp.test` to port 80 of `127.0.0.1`, and your dev server is on 3000, where nothing is listening.",
      },
      {
        kind: "p",
        text: "The missing half is something answering on port 80 *for that name*. Ports below 1024 need root, so that listener has to be started as root — and one name per port means one loopback address per name, because a name resolves to an address and the port is not part of the answer.",
      },
      {
        kind: "figure",
        caption: "the three things an alias actually is",
        value:
          "/etc/hosts     127.0.0.2   myapp.test        (a line inside a marked block)\nlo0 alias      127.0.0.2                     (added as root, cleared by a reboot)\nforwarder      127.0.0.2:80  ──bytes──▶  127.0.0.1:3000",
      },
      {
        kind: "p",
        text: "That is the whole product: it does those three things behind one admin prompt, keeps them consistent as you add, rename and delete aliases, and takes all three back out when you uninstall. Your dev server is not touched, not restarted, and never learns any of it happened.",
      },
    ],
  },

  {
    id: "what-runs-as-root",
    question: "What exactly runs as root, and for how long?",
    blocks: [
      {
        kind: "p",
        text: "One process. It is called the agent, and the agent **is** the TCP forwarder — one root process, not two.",
      },
      {
        kind: "list",
        items: [
          "It starts behind **one macOS admin prompt at app launch**. The prompt runs `osascript … with administrator privileges` on a single script, `Contents/Resources/privileged/apply.sh`, which ships inside the bundle so you can read it before you type your password.",
          "**Nothing is installed.** No `LaunchDaemon` in `/Library`, no `SMAppService` daemon, no `sudoers` entry, no `sudo` installer script. There is no root component left on the machine when the app is not running.",
          "It lives exactly as long as the app. The app touches `~/.config/localhost-aliases/liveness` every 5 seconds and the agent exits by itself once that file has been stale for 15 seconds — a user process cannot kill root, so root owns its own lifetime. Quitting the app is clean and asks for nothing.",
          "While it is up there are no further prompts: it watches `desired-state.json` and reconciles the machine to it — `lo0` addresses, the managed `/etc/hosts` block, a DNS flush, its own routes.",
        ],
      },
      {
        kind: "note",
        tone: "warn",
        title: "The tradeoff, stated plainly",
        text: "`desired-state.json` is writable by your user and a root process acts on it, so any process running as you can ask root to add a loopback address and edit our block in `/etc/hosts`. That is a real local privilege escalation and we would rather you read it here than discover it. It is bounded by the agent never trusting that file: every hostname is re-validated on every read, addresses are confined to the `127.0.0.2`–`127.0.0.254` pool, an address the agent did not allocate is never removed, forward targets must be loopback, and the `/etc/hosts` write is refused outright if a single byte outside the markers would change.",
      },
    ],
  },

  {
    id: "https",
    question: "Can I get https, with a real padlock?",
    blocks: [
      {
        kind: "p",
        text: "Yes. Turn it on in Settings and every alias also answers on `https://`; `http://` keeps working alongside it, so nothing you have bookmarked breaks. This works because each alias owns its own loopback address — a listener on `127.0.0.3:443` already knows which alias it is, so it can present that certificate without reading a single byte of your traffic. No `Host` header is parsed, no SNI is inspected. After the handshake it is the same raw splice as ever, which is why WebSockets and HMR are unaffected.",
      },
      {
        kind: "p",
        text: "The certificate is issued for you and renews itself. One step is deliberately not automatic: your Mac has to be told to trust the local authority that signs it, and macOS asks for your keychain password when you do. An app that quietly installs a trusted root would be indistinguishable from malware, so Settings hands you the command instead. Firefox keeps its own list of trusted authorities and will still warn until you add it there too.",
      },
      {
        kind: "note",
        tone: "info",
        title: "This is why some TLDs are refused",
        text: "`.dev`, `.app`, `.page` and the rest of the HSTS preload list are rejected by validation: the browser rewrites `http://` to `https://` for those names before the request leaves your machine, so you would get a TLS error rather than your app.",
      },
    ],
  },

  {
    id: "test-not-local",
    question: "Why .test and not .local?",
    blocks: [
      {
        kind: "p",
        text: "`.test` is reserved for development by [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.2): never delegated, never publicly resolvable, and claimed by nothing on macOS — so the `/etc/hosts` line is simply the answer, immediately.",
      },
      {
        kind: "p",
        text: "`.local` is reserved for multicast DNS by [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762#section-3), and on macOS `mDNSResponder` owns that suffix. Every lookup goes onto the network as a multicast query and the resolver waits that query out first — roughly **five seconds per name**, measured on a developer Mac by timing `getaddrinfo` directly:",
      },
      {
        kind: "table",
        head: ["name", "in /etc/hosts?", "getaddrinfo"],
        rows: [
          ["`index.local`", "yes", "5.008s"],
          ["`nope-xyz.local`", "**no**", "5.006s"],
          ["`nope-xyz.test`", "no", "0.003s"],
          ["`broadcasthost`", "yes", "0.003s"],
        ],
      },
      {
        kind: "p",
        text: "The second row is the finding: a `.local` name that is in no hosts file at all costs the same five seconds as one that is, so the delay cannot be caused by anything we wrote there. The suffix is the cost. `.localhost` is refused for a different reason — macOS answers that suffix itself as `127.0.0.1` without reading `/etc/hosts`, so the name would never reach the alias's own `127.0.0.x`. The dashboard offers `test`, `internal`, `lan`, `home.arpa` and `example`; the numbers and the commands that produce them are on [how aliases work](/docs/how-aliases-work#tld).",
      },
    ],
  },

  {
    id: "hmr-websockets",
    question: "Does it work with Vite, Next and Rails — HMR, WebSockets, the lot?",
    blocks: [
      {
        kind: "p",
        text: "Yes, and for a boring reason: nothing is parsed, so there is nothing to be incompatible with. The forwarder accepts on `127.0.0.2:80`, connects to `127.0.0.1:3000` and copies bytes in both directions until one side closes. A WebSocket upgrade, an HMR socket, server-sent events, a long-lived streaming response, or a protocol that is not HTTP at all — all of it passes through untouched, and your dev server sees an ordinary client.",
      },
      {
        kind: "list",
        items: [
          "Your dev server has to be listening on `127.0.0.1` or `0.0.0.0`. One bound only to IPv6 `::1` is not reachable — `lsof -nP -iTCP:3000 -sTCP:LISTEN` shows which address it actually took.",
          "The `Host` header arrives as you typed it, `myapp.test`. Frameworks with a host allow-list — Rails' `config.hosts`, Vite's `server.allowedHosts` — will refuse a name they have not been told about, so add it there once.",
          "The origin changes, and anything pinned to `http://localhost:3000` changes with it: a cookie set on `localhost` is not sent to `myapp.test`, and OAuth callbacks or CORS allow-lists need the new origin.",
          "Changing an alias's target port needs no admin prompt — the running agent reloads its routes and retargets itself.",
        ],
      },
    ],
  },

  {
    id: "reboot",
    question: "What happens when I reboot?",
    blocks: [
      {
        kind: "p",
        text: "The `/etc/hosts` block is a file, so it survives untouched. The `lo0` addresses do not — macOS clears extra loopback addresses at boot — and the root agent went with the session that started it.",
      },
      {
        kind: "p",
        text: "So the first launch after a reboot compares the live machine against your configuration and, when it has actually drifted, raises the one admin prompt again to put the addresses back and start the agent. If nothing drifted, it does not prompt. Nothing re-adds itself while the app is not running: that is the same property as \"nothing is installed\", seen from the other side.",
      },
      {
        kind: "p",
        text: "Launch at login is available (`SMAppService`, macOS 13+) and the settings drawer says what it costs before you turn it on: with this model, launching at login means **one admin prompt per login**.",
      },
    ],
  },

  {
    id: "uninstall",
    question: "How do I uninstall, and what is left behind?",
    blocks: [
      {
        kind: "p",
        text: "Quit the app, then run `make uninstall` — or use the tray's `Uninstall…` item, or the dashboard's settings drawer. All three run the same script, and the copy that runs is the one inside the installed bundle, so removing the app never needs a checkout of its source.",
      },
      {
        kind: "steps",
        items: [
          "One admin prompt. As root: stop the agent, remove the `lo0` addresses it added, strip the managed block from `/etc/hosts` leaving every other line byte for byte, flush DNS, and hand back every file root created inside your directories.",
          "Then, with no privileges: remove the local CA from your **login** keychain — matched by SHA-1 fingerprint, never by name, because deleting the wrong certificate is unrecoverable — then `~/.config/localhost-aliases`, the logs, and finally the `.app` itself.",
        ],
      },
      {
        kind: "p",
        text: "What is left behind is nothing of ours. Your projects are untouched, any `.localhost-aliases.json` you asked it to write stays in the repository it belongs to, and `/etc/hosts` keeps every line outside the markers. Cancelling the password prompt removes nothing at all — the run stops there rather than half-dismantling the machine. If a step fails it says so and carries on to the end, so you never end up with an app that has removed its own system state but not itself.",
      },
      {
        kind: "p",
        text: "And if the app is gone, broken, or you simply stop trusting it: both changes are visible and reversible by hand — delete everything between the `# >>> localhost-aliases >>>` markers in `/etc/hosts`, and `sudo ifconfig lo0 -alias 127.0.0.2` for each address. [Troubleshooting](/docs/troubleshooting#by-hand) spells it out.",
      },
    ],
  },

  {
    id: "phone-home",
    question: "Does it phone home? Does it need a network connection?",
    blocks: [
      {
        kind: "p",
        text: "No, and no. There is no telemetry, no analytics, no crash reporting, no account and no licence check — the app makes no outbound connection of its own. Every address it creates is loopback, so nothing it sets up is reachable from your network or from the internet.",
      },
      {
        kind: "p",
        text: "It does not need the network to work either: resolution is a line in `/etc/hosts`, the forwarder connects to `127.0.0.1`, and the traffic never leaves the machine. The only thing that needs an internet connection is you, cloning or downloading it in the first place.",
      },
      {
        kind: "p",
        text: "There is no auto-update, and nothing checks for one. A new build is a download you choose to make; the [changelog](/changelog) is how you find out that one exists.",
      },
    ],
  },

  {
    id: "signing",
    question: "Is it signed and notarized?",
    blocks: [
      {
        kind: "note",
        tone: "warn",
        title: "No — and there is no published build at all",
        text: "No release has been published, nothing has been signed with a Developer ID, and nothing has been submitted to Apple for notarization. The only supported way to get the app today is to build it from the source you can read.",
      },
      {
        kind: "p",
        text: "That is less alarming than it sounds for a source build, and the reason is worth knowing: Gatekeeper acts on the quarantine attribute that a browser attaches to a **downloaded** file. `make install` copies the bundle you compiled a minute ago and clears that attribute, so there is no unidentified-developer dialog — the thing you are trusting is your own compiler, not our signature.",
      },
      {
        kind: "p",
        text: "The release workflow can sign and notarize once the Apple credentials are configured, but no build has been through it. If a `.dmg` ever appears on the [download](/download) page, do not take this page's word for its signature — check the file you actually have:",
      },
      {
        kind: "code",
        label: "what the file itself says",
        value:
          "spctl -a -vvv -t install /Volumes/Localhost\\ Aliases/LocalhostAliases.app\n#   notarized: accepted / source=Notarized Developer ID\n#   otherwise: rejected\nxcrun stapler validate /Volumes/Localhost\\ Aliases/LocalhostAliases.app\n#   proves the ticket is stapled, so the check also holds offline",
      },
    ],
  },

  {
    id: "apple-silicon",
    question: "Apple Silicon or Intel?",
    blocks: [
      {
        kind: "p",
        text: "Apple Silicon only. The tray is compiled with `-target arm64-apple-macos13.0` and there is no universal binary, so there is no x86_64 slice for an Intel Mac to run. Rosetta does not help: it translates Intel code so it can run on Apple Silicon, not the other way round.",
      },
      {
        kind: "p",
        text: "The floor is macOS 13 Ventura, which is `LSMinimumSystemVersion` in the bundle's `Info.plist` and the same version as the Swift deployment target. The rest of the app is Bun and shell, and would port; the menu-bar app and the privileged work — `ifconfig`, `/etc/hosts`, `dscacheutil` — are macOS-shaped and are not intended to.",
      },
    ],
  },
];
