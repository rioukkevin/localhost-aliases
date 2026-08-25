import { verifyCommands } from "../../lib/product.ts";
import { CodeBlock } from "../ui/CodeBlock.tsx";

const CAPS = "text-[10px] font-medium uppercase tracking-[0.16em] text-faint";

/**
 * What macOS will actually do, given the build's REAL signing state.
 *
 * The state as this is written: no release has been published, nothing has been signed with a
 * Developer ID and nothing has been notarized (packages/build/sign.sh signs only when an
 * identity exists; the release workflow's signing and notarization steps are conditional on
 * Apple credentials that no published build has used).
 *
 * The site cannot see a signature through the GitHub API, so when a release does exist this
 * does not claim one either way — it prints the two commands that tell the reader the truth
 * about the file on their own disk. Claiming notarization that has not happened is the one
 * lie this whole page exists to avoid.
 */
export function Gatekeeper({ dmgFilename }: { dmgFilename: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
        Gatekeeper judges the <span className="mono">com.apple.quarantine</span> attribute a browser attaches to a
        downloaded file. That single fact explains both cases below.
      </p>

      <div className="border border-hairline">
        <div className="border-b border-hairline px-3 py-3">
          <p className={CAPS}>if you build from source</p>
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
            Nothing happens. <span className="mono">make install</span> copies the bundle you just compiled and clears
            the quarantine attribute, so there is no downloaded file for Gatekeeper to judge and no dialog. What you
            are trusting there is your own compiler, not our signature.
          </p>
        </div>

        <div className="px-3 py-3">
          <p className={CAPS}>if you download a build that is not notarized</p>
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
            macOS refuses the first launch and says{" "}
            <span className="text-ink">
              “Apple could not verify “LocalhostAliases.app” is free of malware that may harm your Mac or compromise
              your privacy.”
            </span>{" "}
            Opening it anyway is deliberate, and where the override lives moved: on macOS 13 and 14 it is Control-click
            the app then <span className="text-ink">Open</span>; on macOS 15 and later Apple removed that shortcut and
            it is <span className="text-ink">System Settings → Privacy &amp; Security → Open Anyway</span> after the
            first refusal.
          </p>
        </div>
      </div>

      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
        {dmgFilename === null ? (
          <>
            No release has been published, so no build has been signed with a Developer ID or notarized. When one is,
            do not take this page&apos;s word for it — ask the file:
          </>
        ) : (
          <>
            This page cannot see a signature through the GitHub API, so it does not claim one. Ask the file you
            downloaded instead — these are the same checks CI runs against its own artifact:
          </>
        )}
      </p>

      <CodeBlock
        label="what the file itself says"
        value={verifyCommands(dmgFilename ?? "LocalhostAliases.dmg")}
        what="commands"
      />

      <p className="max-w-2xl text-[12px] leading-relaxed text-faint">
        <span className="mono text-muted">accepted / source=Notarized Developer ID</span> is the only output that means
        notarized. Anything else — <span className="mono text-muted">rejected</span>, an ad-hoc signature, no stapled
        ticket — means it is not, whatever any web page says.
      </p>
    </div>
  );
}
