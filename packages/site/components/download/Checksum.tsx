import { checksumCommand } from "../../lib/product.ts";
import { CopyButton } from "../ui/CopyButton.tsx";

const CAPS = "text-[10px] font-medium uppercase tracking-[0.16em] text-faint";

/**
 * The sha256 of the file you are about to open, in full and copyable.
 *
 * In full rather than shortened: a checksum you have to click to reveal is a checksum nobody
 * verifies. `null` is a real state — the checksum is parsed out of the release body, and a
 * release written by hand may simply not carry one — and it says so instead of showing a
 * blank, because an empty checksum field reads as "verified" to a hurried eye.
 */
export function Checksum({ sha256, filename }: { sha256: string | null; filename: string }) {
  if (sha256 === null) {
    return (
      <div className="border border-hairline-strong bg-sunken px-3 py-2.5">
        <p className={CAPS}>sha256</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Not published with this release, so there is nothing here to compare against. Compute it yourself with{" "}
          <code className="mono text-ink">{checksumCommand(filename)}</code> — it still proves the file did not change
          between two machines, it just cannot prove it came from us.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-hairline-strong bg-sunken">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className={CAPS}>sha256</p>
          <p className="mono mt-1 break-all text-[11px] leading-relaxed text-ink">{sha256}</p>
        </div>
        <CopyButton className="border-0 bg-transparent" value={sha256} what="checksum" />
      </div>
      <p className="border-t border-hairline px-3 py-2 text-[11px] leading-relaxed text-faint">
        Verify it before you open it: run <code className="mono text-muted">{checksumCommand(filename)}</code> in the
        folder you downloaded to and check that the output matches this line, character for character.
      </p>
    </div>
  );
}
