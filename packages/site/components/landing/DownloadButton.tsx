import { formatDate, formatSize, getLatestRelease } from "../../lib/releases.ts";
import { shortSha } from "../format.ts";
import { GITHUB_URL } from "../site/links.ts";
import { Chip } from "../ui/Chip.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { IconDownload } from "../ui/Icons.tsx";
import { LinkButton } from "../ui/LinkButton.tsx";

const SOURCE_BUILD = [
  "git clone https://github.com/rioukkevin/localhost-aliases",
  "cd localhost-aliases",
  "bun install",
  "make bundle    # builds dist/LocalhostAliases.app",
  "make install   # copies it into /Applications",
].join("\n");

/**
 * The one call to action. Reads the release manifest CI publishes; when there is
 * none — which is the state today — it offers the only thing that actually exists,
 * a source build, instead of a button that would 404.
 */
export async function DownloadButton() {
  const release = await getLatestRelease();

  if (!release) {
    return (
      <div className="border border-hairline-strong bg-raised">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-4 py-3">
          <Chip tone="down" dot>
            No release published yet
          </Chip>
          <p className="max-w-xl text-[12.5px] leading-relaxed text-muted">
            There is no signed or notarized build to download. Build it from source — nothing on
            your system changes until you launch it and accept the prompt. Apple Silicon only.
          </p>
        </div>

        <div className="px-4 py-4">
          <CodeBlock value={SOURCE_BUILD} what="commands" label="build from source" />
          <p className="mt-3 text-[12px] leading-relaxed text-faint">
            Needs Bun 1.2.5+ and the Xcode command line tools (<span className="mono">swiftc</span>).{" "}
            <span className="mono">make uninstall</span> reverses every change, including the{" "}
            <span className="mono">/etc/hosts</span> block.
          </p>
          <div className="mt-4">
            <LinkButton href={GITHUB_URL} size="md">
              View the source
            </LinkButton>
          </div>
        </div>
      </div>
    );
  }

  const { dmg } = release;

  return (
    <div className="flex flex-col items-start gap-3">
      <LinkButton href={dmg.url} variant="primary" size="lg" external>
        <IconDownload />
        Download {release.version}
      </LinkButton>

      <p className="mono text-[11px] leading-relaxed text-faint">
        {dmg.filename} · {formatSize(dmg.size)}
        {release.minimumMacOS ? ` · macOS ${release.minimumMacOS}+` : ""} · Apple Silicon ·{" "}
        {formatDate(release.publishedAt)}
        {dmg.sha256 ? (
          <>
            <br />
            sha256 {shortSha(dmg.sha256)}
          </>
        ) : null}
      </p>
    </div>
  );
}
