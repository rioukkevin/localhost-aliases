import type { Metadata } from "next";
import Link from "next/link";
import { BuildFromSource } from "../../components/download/BuildFromSource.tsx";
import { Checksum } from "../../components/download/Checksum.tsx";
import { Gatekeeper } from "../../components/download/Gatekeeper.tsx";
import { GITHUB_URL } from "../../components/site/links.ts";
import { Banner } from "../../components/ui/Banner.tsx";
import { Chip } from "../../components/ui/Chip.tsx";
import { IconDownload } from "../../components/ui/Icons.tsx";
import { LinkButton } from "../../components/ui/LinkButton.tsx";
import { Panel } from "../../components/ui/Panel.tsx";
import { ARCHITECTURE, MINIMUM_MACOS, MINIMUM_MACOS_NAME } from "../../lib/product.ts";
import { formatDate, formatSize, getLatestRelease } from "../../lib/releases.ts";
import { Inline } from "../docs/blocks.tsx";

export const metadata: Metadata = {
  title: "Download",
  description: `Localhost Aliases for macOS ${MINIMUM_MACOS}+ on ${ARCHITECTURE}. The .dmg with its size and sha256, what Gatekeeper will say, and how to build it from source while no release is published.`,
  alternates: { canonical: "/download" },
};

const LINK = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";

/** Inline markup here is the docs' own: `code` and **strong**, rendered by <Inline>. */
const REQUIREMENTS = [
  `macOS ${MINIMUM_MACOS} ${MINIMUM_MACOS_NAME} or later — \`LSMinimumSystemVersion\` in the bundle, and the Swift deployment target.`,
  "**Apple Silicon only.** The tray is compiled `-target arm64-apple-macos13.0` and there is no universal binary, so there is no x86_64 slice. An Intel Mac cannot run it, and Rosetta translates the other direction.",
  "An admin account, for one prompt at launch. Nothing is installed into `/Library`, and there is no `sudoers` entry.",
  "No network connection. Resolution is a line in `/etc/hosts`, and the traffic never leaves loopback.",
];

/**
 * The download page.
 *
 * Three states, and the third is today's: a release with a `.dmg`, a release whose `.dmg` is
 * missing (an upload that failed, a notes-only tag), and no release at all — which is what
 * the GitHub API actually answers for this repository right now. None of them shows a button
 * that would 404, and none of them claims a signature that does not exist.
 */
export default async function DownloadPage() {
  const release = await getLatestRelease();
  const dmg = release?.dmg ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">Download</h1>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
          A menu-bar app for macOS {MINIMUM_MACOS} and later, on {ARCHITECTURE}. It installs no system component: the
          only thing it leaves running is one root process that exits when you quit.
        </p>
      </header>

      <div className="flex flex-col gap-8">
        <Panel
          aside={
            release === null ? (
              <Chip dot tone="down">
                no release yet
              </Chip>
            ) : (
              <Chip tone="accent">{release.prerelease ? "pre-release" : "latest"}</Chip>
            )
          }
          meta={release !== null && release.publishedAt !== "" ? formatDate(release.publishedAt) : undefined}
          title={release === null ? "Build from source" : release.tag}
        >
          {release !== null && dmg !== null ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col items-start gap-3">
                <LinkButton external href={dmg.url} size="lg" variant="primary">
                  <IconDownload />
                  Download {release.version}
                </LinkButton>
                <p className="mono text-[11px] leading-relaxed text-faint">
                  {dmg.filename} · {formatSize(dmg.size)} · macOS {release.minimumMacOS}+ · {ARCHITECTURE}
                  {release.publishedAt !== "" ? ` · ${formatDate(release.publishedAt)}` : ""}
                </p>
              </div>

              <Checksum filename={dmg.filename} sha256={dmg.sha256} />

              <p className="text-[12.5px] leading-relaxed text-muted">
                Release notes are on the{" "}
                <Link className={LINK} href="/changelog">
                  changelog
                </Link>
                , and the{" "}
                <a className={LINK} href={release.htmlUrl} rel="noreferrer noopener" target="_blank">
                  release on GitHub
                </a>{" "}
                carries the same file.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {release === null ? (
                <Banner title="No release has been published yet" tone="warn">
                  The GitHub repository has no tags and no releases, so there is nothing to download — and nothing has
                  been code-signed or notarized. Build it from source instead: it is a handful of commands, and you get to read
                  the script that will run as root before you run it.
                </Banner>
              ) : (
                <Banner title={`${release.tag} has no .dmg attached`} tone="warn">
                  The release exists but carries no disk image, so there is no file to hand you. Build from source
                  while that is the case — the tag below is the same code.
                </Banner>
              )}

              <BuildFromSource />

              {release !== null && (
                <p className="text-[12.5px] leading-relaxed text-muted">
                  The{" "}
                  <a className={LINK} href={release.htmlUrl} rel="noreferrer noopener" target="_blank">
                    {release.tag} release on GitHub
                  </a>{" "}
                  has the notes, and the{" "}
                  <Link className={LINK} href="/changelog">
                    changelog
                  </Link>{" "}
                  lists every build.
                </p>
              )}
            </div>
          )}
        </Panel>

        <Panel meta="macOS only" title="Requirements">
          <ul className="flex flex-col gap-2">
            {REQUIREMENTS.map((item, i) => (
              <li className="flex gap-3 text-[13px] leading-relaxed text-muted" key={i}>
                <span aria-hidden className="mt-[9px] h-px w-3 shrink-0 bg-hairline-strong" />
                <span className="min-w-0">
                  <Inline text={item} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="What macOS will say">
          <Gatekeeper dmgFilename={dmg?.filename ?? null} />
        </Panel>

        <Panel title="What it changes on your Mac">
          <div className="flex flex-col gap-3">
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
              Three things, all visible and all reversible: a marked block in{" "}
              <span className="mono">/etc/hosts</span>, one loopback address per alias on{" "}
              <span className="mono">lo0</span>, and one root process forwarding{" "}
              <span className="mono">127.0.0.x:80</span> to the port your dev server already listens on. The root
              process exits by itself when the app stops, and{" "}
              <span className="mono">make uninstall</span> takes the other two back out.
            </p>
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
              Project aliases are <span className="mono">http://</span> only — the forwarder moves raw bytes and never
              parses them, so nothing in that path could terminate TLS. The{" "}
              <Link className={LINK} href="/faq#what-runs-as-root">
                FAQ
              </Link>{" "}
              covers what runs as root and for how long, including the tradeoff that comes with it, and the{" "}
              <a className={LINK} href={GITHUB_URL} rel="noreferrer noopener" target="_blank">
                source
              </a>{" "}
              is the final word on all of it.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
