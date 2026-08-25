import Link from "next/link";
import { DownloadButton } from "../components/landing/DownloadButton.tsx";
import { MachineFigure } from "../components/landing/MachineFigure.tsx";
import { MechanismFigure } from "../components/landing/MechanismFigure.tsx";
import { PatchbayFigure } from "../components/landing/PatchbayFigure.tsx";
import { ProblemFigure } from "../components/landing/ProblemFigure.tsx";
import { FactList, Section } from "../components/landing/Section.tsx";
import { GITHUB_URL } from "../components/site/links.ts";
import { Banner } from "../components/ui/Banner.tsx";
import { Chip } from "../components/ui/Chip.tsx";
import { LinkButton } from "../components/ui/LinkButton.tsx";
import { Panel } from "../components/ui/Panel.tsx";

const MCP_TOOLS = [
  "list_aliases",
  "list_projects",
  "create_alias",
  "delete_alias",
  "link_project",
  "get_usage_instructions",
];

export default function LandingPage() {
  return (
    <>
      <section className="mx-auto w-full max-w-5xl px-4 pb-14 pt-12 md:px-8 md:pb-20 md:pt-16">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="accent">macOS menu bar app</Chip>
          <Chip>open source</Chip>
        </div>

        <h1 className="mt-5 max-w-3xl text-[30px] font-semibold leading-[1.15] tracking-tight text-ink md:text-[40px]">
          Real hostnames for the dev servers already running on your Mac.
        </h1>

        <p className="mono mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] md:text-[17px]">
          <span className="text-faint line-through">http://localhost:3000</span>
          <span aria-hidden="true" className="text-faint">
            →
          </span>
          <span className="text-ink">
            http://myapp<span className="text-faint">.test</span>
          </span>
        </p>

        <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-muted md:text-[14px]">
          Every alias gets its own loopback address and one line in{" "}
          <span className="mono">/etc/hosts</span>. A small root process then splices port 80 on
          that address to the port your dev server is already listening on. One admin prompt,
          nothing permanently installed, and{" "}
          <a href="#http-only" className="text-ink underline underline-offset-4">
            http:// only
          </a>
          .
        </p>

        <div className="mt-8 max-w-2xl">
          <DownloadButton />

          <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
            The{" "}
            <Link href="/download" className="text-ink underline underline-offset-4">
              download page
            </Link>{" "}
            has the version, the size, the sha256 and what Gatekeeper will actually say. The{" "}
            <Link href="/faq" className="text-ink underline underline-offset-4">
              FAQ
            </Link>{" "}
            answers the sceptical questions: what runs as root and for how long, why there is no{" "}
            <span className="mono">https</span>, and what is left behind when you uninstall.
          </p>
        </div>

        <div className="mt-12">
          <PatchbayFigure />
        </div>
      </section>

      <Section
        id="why"
        eyebrow="the problem"
        title="localhost:3000 tells you nothing"
        lede="A port number is not a name. Everything your browser keys on the origin gets keyed on a number that means nothing and moves the next time something else grabs it first."
      >
        <ProblemFigure />

        <div className="mt-8">
          <FactList
          items={[
            {
              term: "The tab bar",
              detail: (
                <>
                  Five projects open, and the tabs read{" "}
                  <span className="mono">:3000 :3001 :5173 :4321 :8080</span>. You find the right
                  one by clicking until it looks familiar.
                </>
              ),
            },
            {
              term: "History and autofill",
              detail:
                "Both key on the origin. Search your history for the project and you get nothing, because the project was never called anything.",
            },
            {
              term: "Cookies",
              detail: (
                <>
                  Cookies ignore the port, so everything served from{" "}
                  <span className="mono">localhost</span> shares one cookie jar. Two apps that both
                  set <span className="mono">session</span> overwrite each other.
                </>
              ),
            },
            {
              term: "Sharing a URL",
              detail:
                "A link in a README or a ticket only works if the reader happens to have started the same server on the same port.",
            },
          ]}
          />
        </div>
      </Section>

      <Section
        id="how-it-works"
        eyebrow="the mechanism"
        title="A name, an address, and a splice"
        lede="DNS maps a name to an IP, never to a port. So each alias gets its own loopback IP, and a raw TCP forwarder carries port 80 on that address to the port you already use."
      >
        <MechanismFigure />

        <div className="mt-8">
          <FactList
            items={[
              {
                term: "1 — a loopback address",
                detail: (
                  <>
                    The lowest free address in{" "}
                    <span className="mono">127.0.0.2 … 127.0.0.254</span> is assigned when the alias
                    is created and stays with it for life.{" "}
                    <span className="mono">127.0.0.1</span> is never used. That is a ceiling of 253
                    aliases, and the app says so if you reach it.
                  </>
                ),
              },
              {
                term: "2 — one line in /etc/hosts",
                detail: (
                  <>
                    All entries live inside a single managed block between markers. Everything
                    outside those markers is preserved byte for byte, so whatever else you keep in{" "}
                    <span className="mono">/etc/hosts</span> is left exactly as it was.
                  </>
                ),
              },
              {
                term: "3 — raw byte forwarding",
                detail:
                  "A small root process binds :80 on that address and copies bytes to 127.0.0.1:<your port>. It parses nothing — no Host header, no header rewriting — so WebSockets, HMR and non-HTTP protocols pass straight through with no configuration.",
              },
            ]}
          />
        </div>

      </Section>

      <Section
        id="on-your-machine"
        eyebrow="what changes here"
        title="Two markers in /etc/hosts, an address on lo0, one prompt"
        lede="Everything privileged is one idempotent apply. This is the whole of it, so you can decide before you type a password rather than after."
      >
        <MachineFigure />

        <div className="mt-8">
          <Panel title="What runs as root" meta="four operations, nothing else">
            <ol className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted">
              <li>
                <span className="text-ink">Loopback addresses.</span>{" "}
                <span className="mono">ifconfig lo0 alias|-alias 127.0.0.x</span> — only inside the
                pool, and only for addresses it allocated itself.
              </li>
              <li>
                <span className="text-ink">The managed block.</span> It rewrites{" "}
                <span className="mono">/etc/hosts</span> between the two markers, atomically, and
                refuses to write at all if a byte outside them would change.
              </li>
              <li>
                <span className="text-ink">The DNS cache.</span>{" "}
                <span className="mono">dscacheutil -flushcache</span> and{" "}
                <span className="mono">killall -HUP mDNSResponder</span>, so the new name answers
                immediately.
              </li>
              <li>
                <span className="text-ink">Bytes between sockets.</span> It binds{" "}
                <span className="mono">:80</span> on each of those addresses and copies bytes to{" "}
                <span className="mono">127.0.0.1:&lt;your port&gt;</span>.
              </li>
            </ol>

            <p className="mt-4 border-t border-hairline pt-4 text-[12.5px] leading-relaxed text-muted">
              That is the entire list. The agent re-validates every hostname, address and port it
              reads before acting on any of them, and{" "}
              <span className="text-ink">nothing named in that file is ever executed</span>. One bad
              entry rejects the whole file and leaves the previous state in place.
            </p>
          </Panel>
        </div>
      </Section>

      <Section
        id="http-only"
        eyebrow="a real limitation"
        title="Project aliases are http:// only"
        lede="This is the trade-off at the centre of the design, so it is stated here rather than discovered later."
      >
        <Banner tone="warn" title="There is no TLS for your aliases, and there cannot be">
          <p>
            The forwarder moves raw bytes and never looks inside them. That is exactly why
            WebSockets and HMR need no configuration — and it is also why it cannot terminate TLS:
            nothing in the path ever parses a request, so there is nowhere to present a certificate
            for <span className="mono">myapp.test</span>. Anything that requires a secure context
            in the browser — service workers, <span className="mono">getUserMedia</span>, WebAuthn —
            still needs <span className="mono">http://localhost</span>, which browsers treat as
            secure.
          </p>
          <p className="mt-2.5">
            <span className="mono">https://</span> works for the dashboard alone, because that
            server is ours: onboarding can optionally generate a local CA and trust it in your{" "}
            <span className="text-ink">login keychain</span> — a click, not a{" "}
            <span className="mono">sudo</span> command — for{" "}
            <span className="mono">https://index.test</span>. Firefox keeps its own trust store and
            the flow says so.
          </p>
        </Banner>
      </Section>

      <Section
        id="standing-root"
        eyebrow="the other real limitation"
        title="A root process acts on a file your user account can write"
        lede="This is what one prompt per launch actually costs, so it is stated here rather than discovered later."
      >
        <Banner tone="warn" title="While the app runs, anything running as you can reach root through it">
          <p>
            The prompt at launch starts the <span className="text-ink">root agent</span>. It watches{" "}
            <span className="mono">~/.config/localhost-aliases/desired-state.json</span> — a file{" "}
            <span className="text-ink">your user account can write</span> — and reconciles the
            machine to it with no further password. So any process running as you can ask root to
            edit <span className="mono">/etc/hosts</span> and add loopback addresses, silently, for
            as long as the app is open. That is a real local privilege escalation, and it is the
            price of not being asked for your password on every edit.{" "}
            <span className="text-ink">Quit the app and nothing runs as root.</span>
          </p>
          <p className="mt-2.5">
            It is bounded by validation the agent does itself, never trusting the file: hostnames
            re-checked on every read (no whitespace, no <span className="mono">#</span>, no
            newlines, no <span className="mono">localhost</span>); only{" "}
            <span className="mono">127.0.0.2–127.0.0.254</span> ever added to or removed from{" "}
            <span className="mono">lo0</span>, never <span className="mono">127.0.0.1</span> and
            never an address it did not allocate; <span className="mono">/etc/hosts</span> edits
            confined to the managed block and refused if one byte outside it would change; a port
            at or below 1024 bound only on a pool address. One bad entry rejects the whole file and
            leaves the previous state untouched.{" "}
            <span className="text-ink">Nothing named in that file is ever executed.</span>
          </p>
        </Banner>
      </Section>

      <Section
        id="limits"
        eyebrow="scope"
        title="What it does not do"
        lede="A tool that edits /etc/hosts as root should be explicit about its edges."
      >
        <FactList
          items={[
            {
              term: "Terminate TLS for aliases",
              detail: (
                <>
                  <span className="mono">http://</span> only, for the reason above. Only the
                  dashboard can be served over <span className="mono">https://</span>.
                </>
              ),
            },
            {
              term: "Run or supervise your servers",
              detail:
                "Your dev server on :3000 is not started, restarted, wrapped or touched. If nothing is listening, the alias simply reports no server.",
            },
            {
              term: "Expose anything",
              detail:
                "Every address it creates is loopback. Nothing becomes reachable from your network or the internet — this is not a tunnel and not a sharing tool.",
            },
            {
              term: "Inspect or rewrite traffic",
              detail:
                "No headers are touched and no requests are logged. It cannot do either: it never parses the bytes it forwards.",
            },
            {
              term: "Leave a background service",
              detail:
                "Nothing survives quitting the app except the /etc/hosts block and the lo0 addresses, and make uninstall removes both.",
            },
            {
              term: "Run anywhere but macOS",
              detail:
                "It is built on /etc/hosts, lo0 aliases and a Swift menu-bar app. There is no Linux or Windows build.",
            },
            {
              term: "Ship signed or notarized",
              detail:
                "No signed, notarized build has been published yet. Today you build it from source on your own machine.",
            },
          ]}
        />
      </Section>

      <Section
        id="mcp"
        eyebrow="for coding agents"
        title="An MCP server, so your agent knows which URL is which"
        lede="A stdio MCP server ships with the app and talks to the local dashboard API. Setup installs it into Claude Code or Codex in one click, with a copy-paste snippet as the fallback."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Tools" meta={`${MCP_TOOLS.length} exposed`}>
            <ul className="flex flex-col gap-2">
              {MCP_TOOLS.map((tool) => (
                <li key={tool} className="mono text-[13px] text-ink">
                  {tool}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="What that buys you">
            <ul className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted">
              <li>
                The agent can read the aliases and projects on this machine, so it writes{" "}
                <span className="mono">http://myapp.test</span> in your docs and tests instead of
                guessing a port.
              </li>
              <li>
                It can register an alias for the repo it is working in, and link a folder to a URL.
              </li>
              <li>
                <span className="text-ink">While the root agent is running, an agent&rsquo;s alias
                changes land without a further password prompt</span> — the same as your own. If
                that is not what you want, quit the app: nothing runs as root once it is closed.
              </li>
            </ul>
          </Panel>
        </div>
      </Section>

      <Section
        id="requirements"
        eyebrow="before you start"
        title="Requirements"
        lede="Short list, plus the one thing worth knowing about the TLD before you name anything."
      >
        <FactList
          items={[
            {
              term: "macOS 13 or later, Apple Silicon",
              detail:
                "The menu-bar app is built with a 13.0 (Ventura) deployment target and an arm64-only Swift target, so it runs on Apple Silicon. There is no Intel or universal build today \u2014 building on an Intel Mac produces an arm64 binary that will not launch there.",
            },
            {
              term: "An admin account",
              detail:
                "You are asked for your password once per app launch, to start the root agent. Alias changes after that \u2014 adding, removing, re-porting \u2014 never prompt again.",
            },
            {
              term: "To build it",
              detail: (
                <>
                  Bun 1.2.5 or later and the Xcode command line tools (
                  <span className="mono">swiftc</span>). Then{" "}
                  <span className="mono">make bundle &amp;&amp; make install</span>.
                </>
              ),
            },
            {
              term: "Names end in .test",
              detail: (
                <>
                  <span className="mono">.test</span> is reserved for development by RFC 6761:
                  never delegated, never publicly resolvable, and claimed by nothing on macOS, so
                  the <span className="mono">/etc/hosts</span> entry answers immediately.{" "}
                  <span className="mono">.local</span> is not offered —{" "}
                  <span className="mono">mDNSResponder</span> owns that suffix and every lookup
                  waits out a multicast query, about five seconds per name, measured. HSTS-preloaded
                  TLDs like <span className="mono">.dev</span> and <span className="mono">.app</span>{" "}
                  are refused too: browsers force them to <span className="mono">https://</span>,
                  which aliases cannot serve.
                </>
              ),
            },
          ]}
        />

        <div className="mt-8 flex flex-wrap gap-2">
          <LinkButton href="/download" variant="primary" size="md">
            Get the app
          </LinkButton>
          <LinkButton href="/docs" size="md">
            Read the docs
          </LinkButton>
          <LinkButton href="/faq" size="md">
            FAQ
          </LinkButton>
          <LinkButton href={GITHUB_URL} size="md" external>
            Source on GitHub
          </LinkButton>
        </div>
      </Section>
    </>
  );
}
