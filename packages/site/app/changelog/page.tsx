import type { Metadata } from "next";
import { Chip } from "../../components/ui/Chip.tsx";
import { CodeBlock } from "../../components/ui/CodeBlock.tsx";
import { CopyButton } from "../../components/ui/CopyButton.tsx";
import { IconDownload } from "../../components/ui/Icons.tsx";
import { LinkButton } from "../../components/ui/LinkButton.tsx";
import { Panel } from "../../components/ui/Panel.tsx";
import { GITHUB_URL } from "../../components/site/links.ts";
import { formatDate, formatSize, getAllReleases, type Release } from "../../lib/releases.ts";
import { ReleaseNotes } from "./notes.tsx";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every published build of Localhost Aliases, with its download and its sha256.",
  alternates: { canonical: "/changelog" },
};

const CAPS = "text-[10px] font-medium uppercase tracking-[0.16em] text-faint";

/**
 * The download details. The sha256 is shown in full rather than shortened: a checksum you
 * have to click to reveal is a checksum nobody verifies.
 */
function Download({ release }: { release: Release }) {
  return (
    <div className="border border-hairline-strong bg-sunken">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-3 py-2.5">
        <a
          className="mono inline-flex items-center gap-2 text-[13px] text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent"
          href={release.dmg.url}
        >
          <IconDownload />
          {release.dmg.filename}
        </a>
        <span className="mono text-[11px] text-faint">{formatSize(release.dmg.size)}</span>
        {release.minimumMacOS !== null && (
          <span className="mono text-[11px] text-faint">macOS {release.minimumMacOS}+</span>
        )}
        {/* The tray is compiled with an arm64-only Swift target and CI runs on an Apple Silicon
            runner, so every published DMG is arm64. The manifest schema carries no arch field. */}
        <span className="mono text-[11px] text-faint">Apple Silicon</span>
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className={CAPS}>sha256</p>
          <p className="mono mt-1 break-all text-[11px] leading-relaxed text-muted">{release.dmg.sha256}</p>
        </div>
        <CopyButton className="border-0 bg-transparent" value={release.dmg.sha256} what="checksum" />
      </div>

      <p className="border-t border-hairline px-3 py-2 text-[11px] leading-relaxed text-faint">
        Verify it before you open it: <code className="mono text-muted">shasum -a 256 {release.dmg.filename}</code>
      </p>
    </div>
  );
}

/**
 * Today's real state: nothing has been published. Show how to build the thing rather than a
 * download button that 404s.
 */
function NothingPublished() {
  return (
    <Panel meta="0 builds" title="No releases yet">
      <div className="flex flex-col gap-4">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          Nothing has been published to a release feed, so there is no download here — and nothing has been code-signed
          or notarized. Build it from source instead: it is a few commands, and you get to read what you are about to
          run as root before you run it.
        </p>
        <CodeBlock
          label="build from source"
          value={"git clone https://github.com/rioukkevin/localhost-aliases.git\ncd localhost-aliases\nbun install && make bundle && make install"}
          what="commands"
        />
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/docs/installation">Installation guide</LinkButton>
          <LinkButton href={GITHUB_URL} variant="ghost">
            Source on GitHub
          </LinkButton>
        </div>
      </div>
    </Panel>
  );
}

export default async function ChangelogPage() {
  const releases = await getAllReleases();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">Changelog</h1>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
          Every published build, newest first, with the checksum of the file you are about to download.
        </p>
      </header>

      {releases.length === 0 ? (
        <NothingPublished />
      ) : (
        <ol className="flex flex-col gap-8">
          {releases.map((release, i) => (
            <li key={release.version}>
              <Panel
                aside={i === 0 ? <Chip tone="accent">latest</Chip> : undefined}
                meta={<time dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time>}
                title={release.tag}
              >
                <div className="flex flex-col gap-5">
                  <ReleaseNotes notes={release.notes} />
                  <Download release={release} />
                </div>
              </Panel>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
