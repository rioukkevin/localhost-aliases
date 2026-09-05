import Link from "next/link";
import { DownloadButton } from "../components/landing/DownloadButton.tsx";
import { FlowSchema } from "../components/landing/FlowSchema.tsx";
import { HeroSwap } from "../components/landing/HeroSwap.tsx";
import { PatchbayFigure } from "../components/landing/PatchbayFigure.tsx";
import { FactList, Section } from "../components/landing/Section.tsx";
import { TrustBlock } from "../components/landing/TrustBlock.tsx";
import { ValueTiles } from "../components/landing/ValueTiles.tsx";
import { GITHUB_URL } from "../components/site/links.ts";
import { Chip } from "../components/ui/Chip.tsx";
import { LinkButton } from "../components/ui/LinkButton.tsx";

const LINK = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";

/**
 * Five sections, in the order a stranger needs them: what it is, how it works,
 * why it is worth it, what it does to your machine, and how to get it. Anything
 * that wanted a fourth paragraph lives on /docs or /faq and is linked from the
 * line that raises it — the homepage's job is to be understood, not exhaustive.
 */
export default function LandingPage() {
  return (
    <>
      <section className="mx-auto w-full max-w-5xl px-4 pb-12 pt-12 md:px-8 md:pb-16 md:pt-16">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="accent">macOS menu bar app</Chip>
          <Chip>open source</Chip>
        </div>

        <h1 className="mt-5 max-w-3xl text-[30px] font-semibold leading-[1.15] tracking-tight text-ink md:text-[42px]">
          Real names for the dev servers already running on your Mac.
        </h1>

        <div className="mt-8 md:mt-10">
          <HeroSwap />
        </div>

        <p className="mt-8 max-w-xl text-[13px] leading-relaxed text-muted md:mt-10 md:text-[14px]">
          Point a name at the port your dev server already listens on. One admin prompt when the app launches,
          nothing permanently installed, and no change to how you start anything.
        </p>

        <div className="mt-7">
          <DownloadButton />
        </div>

        <div className="mt-12 md:mt-14">
          <PatchbayFigure />
        </div>
      </section>

      <Section
        eyebrow="how it works"
        id="how-it-works"
        lede="A name resolves to an address and never to a port. So each alias is given a loopback address of its own, and a root process splices port 80 there onto the port you already use. Scroll to follow one request down the wire."
        title="A name, an address, and a splice"
      >
        <FlowSchema />
      </Section>

      <Section
        eyebrow="why bother"
        id="why"
        lede="A port number is not a name: it means nothing, and it moves the next time something else grabs it first."
        title="What a name actually buys you"
      >
        <ValueTiles />
      </Section>

      <Section
        eyebrow="what changes here"
        id="on-your-machine"
        lede="Everything privileged is one idempotent apply, and this is the whole of it — so you can decide before you type a password rather than after."
        title="Two markers in /etc/hosts, one address on lo0, one prompt"
      >
        <TrustBlock />
      </Section>

      <Section
        eyebrow="get it"
        id="get-it"
        lede="It runs entirely on your machine. Every address it creates is loopback, so nothing becomes reachable from your network or the internet."
        title="macOS 13 or later, Apple Silicon, an admin account"
      >
        <div className="flex flex-col gap-8">
          <DownloadButton />

          <FactList
            items={[
              {
                term: "What it will not do",
                detail: (
                  <>
                    It does not start, restart or wrap your dev server, expose anything beyond loopback, or inspect a
                    byte it forwards. There is no Linux or Windows build.{" "}
                    <Link className={LINK} href="/docs/how-aliases-work">
                      How aliases work
                    </Link>{" "}
                    has the edges in full.
                  </>
                ),
              },
              {
                term: "For coding agents",
                detail: (
                  <>
                    An MCP server ships with the app, so your agent can list and create aliases and write{" "}
                    <span className="mono">http://myapp.test</span> in your docs and tests instead of guessing a
                    port. One-click install into Claude Code or Codex, on{" "}
                    <Link className={LINK} href="/docs/mcp">
                      the MCP page
                    </Link>
                    .
                  </>
                ),
              },
              {
                term: "Names end in .test",
                detail: (
                  <>
                    Reserved for development by RFC 6761 and claimed by nothing on macOS, so the{" "}
                    <span className="mono">/etc/hosts</span> line simply answers.{" "}
                    <span className="mono">.local</span> is not offered: it costs about five seconds per lookup, and{" "}
                    <Link className={LINK} href="/faq#test-not-local">
                      the FAQ has the measurements
                    </Link>
                    .
                  </>
                ),
              },
            ]}
          />

          <div className="flex flex-wrap gap-2">
            <LinkButton href="/docs" size="md">
              Read the docs
            </LinkButton>
            <LinkButton href="/faq" size="md">
              FAQ
            </LinkButton>
            <LinkButton external href={GITHUB_URL} size="md">
              Source on GitHub
            </LinkButton>
          </div>
        </div>
      </Section>
    </>
  );
}
