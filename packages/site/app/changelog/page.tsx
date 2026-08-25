import type { Metadata } from "next";
import Link from "next/link";
import { BuildFromSource } from "../../components/download/BuildFromSource.tsx";
import { Checksum } from "../../components/download/Checksum.tsx";
import { GITHUB_RELEASES_URL } from "../../components/site/links.ts";
import { Chip } from "../../components/ui/Chip.tsx";
import { IconDownload } from "../../components/ui/Icons.tsx";
import { Panel } from "../../components/ui/Panel.tsx";
import { ARCHITECTURE } from "../../lib/product.ts";
import { formatDate, formatSize, getAllReleases, type Release } from "../../lib/releases.ts";
import { ReleaseNotes } from "./notes.tsx";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every published release of Localhost Aliases, from its GitHub releases — notes, download and sha256.",
  alternates: { canonical: "/changelog" },
};

const LINK = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";

/** The artifact strip: the file, what it is, and the checksum to compare it against. */
function Artifact({ release }: { release: Release }) {
  const { dmg } = release;

  if (dmg === null) {
    return (
      <p className="border border-hairline-strong bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-muted">
        No disk image is attached to this release, so there is nothing to download here.{" "}
        <a className={LINK} href={release.htmlUrl} rel="noreferrer noopener" target="_blank">
          The release on GitHub
        </a>{" "}
        is the source of truth for what it does carry.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-hairline-strong bg-sunken px-3 py-2.5">
        <a className={`mono inline-flex items-center gap-2 text-[13px] ${LINK}`} href={dmg.url}>
          <IconDownload />
          {dmg.filename}
        </a>
        <span className="mono text-[11px] text-faint">{formatSize(dmg.size)}</span>
        <span className="mono text-[11px] text-faint">macOS {release.minimumMacOS}+</span>
        {/* The tray is compiled with an arm64-only Swift target, so every build is arm64.
            The API carries no architecture field and none is invented here. */}
        <span className="mono text-[11px] text-faint">{ARCHITECTURE}</span>
      </div>
      <Checksum filename={dmg.filename} sha256={dmg.sha256} />
    </div>
  );
}

/**
 * Today's real state: the repository has no tags and no releases, and the API answers 404.
 * That is not an error to apologise for — it is the state of the project — so the page says
 * so and offers the thing that does exist.
 */
function NothingPublished() {
  return (
    <Panel meta="0 releases" title="No releases yet">
      <div className="flex flex-col gap-4">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          Nothing has been tagged or published on GitHub, so there is no history to show — and nothing has been
          code-signed or notarized. Build it from source instead: you get to read what is about to run as root before
          you run it.
        </p>
        <BuildFromSource />
        <p className="text-[12px] leading-relaxed text-faint">
          When a release exists it appears here automatically, notes and checksum included, within five minutes of
          being published. There is no auto-update in the app: this page is how you find out.
        </p>
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
          Every published release, newest first, straight from{" "}
          <a className={LINK} href={GITHUB_RELEASES_URL} rel="noreferrer noopener" target="_blank">
            GitHub releases
          </a>
          , with the checksum of the file you are about to download.
        </p>
      </header>

      {releases.length === 0 ? (
        <NothingPublished />
      ) : (
        <ol className="flex flex-col gap-8">
          {releases.map((release, i) => (
            <li key={release.tag}>
              <Panel
                aside={
                  <div className="flex items-center gap-2">
                    {release.prerelease ? <Chip tone="down">pre-release</Chip> : null}
                    {i === 0 ? <Chip tone="accent">latest</Chip> : null}
                  </div>
                }
                id={release.tag}
                meta={
                  release.publishedAt !== "" ? (
                    <time dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time>
                  ) : undefined
                }
                title={release.tag}
              >
                <div className="flex flex-col gap-5">
                  {release.notes.trim() === "" ? (
                    <p className="text-[13px] leading-relaxed text-faint">
                      This release was published without notes.{" "}
                      <a className={LINK} href={release.htmlUrl} rel="noreferrer noopener" target="_blank">
                        See it on GitHub
                      </a>
                      .
                    </p>
                  ) : (
                    <ReleaseNotes notes={release.notes} />
                  )}
                  <Artifact release={release} />
                </div>
              </Panel>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-muted">
        The{" "}
        <Link className={LINK} href="/download">
          download page
        </Link>{" "}
        always points at the latest release and says what Gatekeeper will do with it.
      </p>
    </div>
  );
}
