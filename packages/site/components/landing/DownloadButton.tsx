import { formatDate, formatSize, getLatestRelease } from "../../lib/releases.ts";
import { shortSha } from "../format.ts";
import { Chip } from "../ui/Chip.tsx";
import { IconDownload } from "../ui/Icons.tsx";
import { LinkButton } from "../ui/LinkButton.tsx";

/**
 * The one call to action, in both of its states.
 *
 * Whatever the GitHub API says, this renders exactly one accent button, because
 * a page with two equally-weighted things to click has none. When there is no
 * published `.dmg` — a release whose upload failed, a notes-only tag, or no
 * release the API will show us at all — the button points at the download page,
 * where the source build has room to be explained properly. The commands
 * themselves do not belong in a hero.
 */
export async function DownloadButton() {
  const release = await getLatestRelease();
  const dmg = release?.dmg ?? null;

  if (release === null || dmg === null) {
    return (
      <div className="flex flex-col items-start gap-3">
        <LinkButton href="/download" size="lg" variant="primary">
          Build it from source
        </LinkButton>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Chip dot tone="down">
            no signed build yet
          </Chip>
          <p className="text-[12px] leading-relaxed text-faint">
            Five commands, on the download page. Apple Silicon, macOS 13+.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <LinkButton external href={dmg.url} size="lg" variant="primary">
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
