import Link from "next/link";
import type { ReactNode } from "react";
import { Banner } from "../ui/Banner.tsx";
import { FigureMotion } from "./FigureMotion.tsx";

/**
 * What one admin prompt actually buys, shown as the file it writes.
 *
 * The lines outside the markers are the point of the drawing, so they are drawn
 * first and never move; only the managed block arrives, once, on load. The
 * marker strings are the real ones (packages/core/src/types.ts) — a figure that
 * invented them would teach a reader to look for a block that is not there.
 *
 * The warning below is deliberately on this page rather than only in the FAQ: it
 * is the cost of not being asked for a password on every edit, and a reader
 * should meet it before they download, not after.
 */
const BEFORE = ["##", "# Host Database", "##", "127.0.0.1       localhost"];

const MANAGED_BEGIN = "# >>> localhost-aliases >>>";
const MANAGED_END = "# <<< localhost-aliases <<<";

const ENTRIES = ["127.0.0.2       myapp.test", "127.0.0.3       api.test"];

const AFTER = ["", "# my own line, from years ago", "192.168.1.20    nas"];

const LINK = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";

const RECEIPTS: { term: string; detail: ReactNode }[] = [
  {
    term: "one prompt, per launch",
    detail: (
      <>
        It starts the root agent, which is also the forwarder. Adding, removing, renaming and re-porting aliases
        after that never ask again. A reboot clears <span className="mono">lo0</span>, so the next launch prompts
        once more.
      </>
    ),
  },
  {
    term: "one address per alias",
    detail: (
      <>
        <span className="mono">ifconfig lo0 alias 127.0.0.2</span> — taken from{" "}
        <span className="mono">127.0.0.2 … 127.0.0.254</span> and kept for the alias&rsquo;s life.{" "}
        <span className="mono">127.0.0.1</span> is never used, and an address it did not allocate is never removed.
      </>
    ),
  },
  {
    term: "nothing installed",
    detail: (
      <>
        No launch daemon, no privileged helper, no <span className="mono">sudoers</span> entry. The agent exits by
        itself when the app stops, so quitting leaves nothing running as root — and needs no second prompt.
      </>
    ),
  },
  {
    term: "reversible",
    detail: (
      <>
        Uninstall — from the tray, from the dashboard or with <span className="mono">make uninstall</span> — takes
        the block and the loopback addresses back out, and removes the certificate authority by fingerprint.
      </>
    ),
  },
];

export function TrustBlock() {
  return (
    <div className="flex flex-col gap-6">
      <FigureMotion />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <figure className="border border-hairline bg-canvas">
          <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-raised px-3 py-2">
            <span className="mono text-[11px] text-ink">/etc/hosts</span>
            <span className="ml-auto text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
              1 managed block
            </span>
          </figcaption>

          <div className="overflow-x-auto px-3 py-3">
            <div className="mono whitespace-pre text-[11px] leading-[1.7] md:text-[12px]">
              {BEFORE.map((line, index) => (
                <span className="block text-faint" key={index}>
                  {line}
                </span>
              ))}

              <span className="relative block py-0.5 pl-3">
                <span aria-hidden="true" className="la-bar absolute inset-y-0 left-0 w-[2px] bg-accent" />
                <span className="block text-muted">{MANAGED_BEGIN}</span>
                {ENTRIES.map((entry, index) => (
                  <span
                    className="la-reveal block text-ink"
                    key={entry}
                    style={{ animationDelay: `${360 + index * 220}ms` }}
                  >
                    {entry}
                  </span>
                ))}
                <span className="block text-muted">{MANAGED_END}</span>
              </span>

              {AFTER.map((line, index) => (
                <span className="block text-faint" key={index}>
                  {line === "" ? " " : line}
                </span>
              ))}
            </div>
          </div>

          <p className="border-t border-hairline px-3 py-2 text-[11px] leading-relaxed text-faint">
            Above and below the markers: preserved byte for byte. The agent refuses to write at all if one byte
            outside the block would change.
          </p>
        </figure>

        <ul className="divide-y divide-hairline border-y border-hairline">
          {RECEIPTS.map((receipt) => (
            <li className="py-3.5" key={receipt.term}>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{receipt.term}</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{receipt.detail}</p>
            </li>
          ))}
        </ul>
      </div>

      <Banner title="The tradeoff, stated here rather than discovered later" tone="warn">
        <p>
          The agent reconciles your machine to a file your own account can write, and that is exactly what buys you
          one prompt instead of one per change: while the app runs, anything running as you can ask root to edit that
          block. It is bounded — every hostname, address and port is re-validated on each read, only{" "}
          <span className="mono">127.0.0.2–127.0.0.254</span> is ever touched, and{" "}
          <span className="text-ink">nothing named in that file is ever executed</span>.{" "}
          <span className="text-ink">Quit the app and nothing runs as root.</span>{" "}
          <Link className={LINK} href="/faq#what-runs-as-root">
            The long answer is in the FAQ
          </Link>
          .
        </p>
      </Banner>
    </div>
  );
}
