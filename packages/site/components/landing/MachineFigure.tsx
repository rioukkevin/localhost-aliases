import type { ReactNode } from "react";
import { FigureFrame } from "./FigureFrame.tsx";

/**
 * What an apply actually does to your machine, shown as the file it writes.
 *
 * The lines outside the markers are the point of the drawing, so they are drawn
 * first and never move; only the managed block arrives, once, on load. The accent
 * edge marks the exact extent of what root is allowed to touch.
 *
 * The marker strings are the real ones (packages/core/src/types.ts) — a figure
 * that invents them would teach a reader to look for a block that is not there.
 */
const BEFORE = [
  "##",
  "# Host Database",
  "##",
  "127.0.0.1       localhost",
  "255.255.255.255 broadcasthost",
];

const MANAGED_BEGIN = "# >>> localhost-aliases >>>";
const MANAGED_END = "# <<< localhost-aliases <<<";

const ENTRIES = ["127.0.0.2       myapp.test", "127.0.0.3       api.test"];

const AFTER = ["", "# my own line, from years ago", "192.168.1.20    nas"];

function Receipt({ term, children }: { term: string; children: ReactNode }) {
  return (
    <li className="py-3.5 first:pt-0 last:pb-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{term}</p>
      <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{children}</div>
    </li>
  );
}

/** A thing that is deliberately absent. The rule, not the exception. */
function Absent({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-2">
      <span aria-hidden="true" className="mono text-[12px] text-faint">
        ✕
      </span>
      <span className="mono text-[11.5px] text-muted line-through decoration-hairline-strong">
        {children}
      </span>
    </li>
  );
}

export function MachineFigure() {
  return (
    <FigureFrame
      label="on your machine"
      meta="one apply, as root"
      caption={
        <>
          Everything privileged happens inside those two markers and on{" "}
          <span className="mono">lo0</span>. The agent refuses to write at all if a byte outside the
          block would change, and nothing named in its input is ever executed. What is left when
          you quit: the block and the loopback addresses — no daemon, no launch agent, no helper
          tool.
        </>
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="border border-hairline-strong bg-sunken">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2">
            <span className="mono text-[11px] text-ink">/etc/hosts</span>
            <span className="ml-auto text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
              1 managed block
            </span>
          </div>

          <div className="overflow-x-auto px-3 py-3">
            <div className="mono whitespace-pre text-[11px] leading-[1.7] md:text-[12px]">
              {BEFORE.map((line) => (
                <span key={line} className="block text-faint">
                  {line}
                </span>
              ))}

              <span className="relative block py-0.5 pl-3">
                <span
                  aria-hidden="true"
                  className="la-bar absolute inset-y-0 left-0 w-[2px] bg-accent"
                />
                <span className="block text-muted">{MANAGED_BEGIN}</span>
                {ENTRIES.map((entry, index) => (
                  <span
                    key={entry}
                    className="la-reveal block text-ink"
                    style={{ animationDelay: `${360 + index * 220}ms` }}
                  >
                    {entry}
                  </span>
                ))}
                <span className="block text-muted">{MANAGED_END}</span>
              </span>

              {AFTER.map((line, index) => (
                <span key={index} className="block text-faint">
                  {line === "" ? " " : line}
                </span>
              ))}
            </div>
          </div>

          <p className="border-t border-hairline px-3 py-2 text-[11px] leading-relaxed text-faint">
            Above and below the markers: preserved byte for byte.
          </p>
        </div>

        <ul className="divide-y divide-hairline">
          <Receipt term="lo0 alias">
            <p className="mono text-[12px] text-ink">ifconfig lo0 alias 127.0.0.2</p>
            <p className="mt-1.5">
              One loopback address per alias, taken from{" "}
              <span className="mono">127.0.0.2 … 127.0.0.254</span> and kept for the alias&rsquo;s
              life. <span className="mono">127.0.0.1</span> is never used, and an address the agent
              did not allocate is never removed.
            </p>
          </Receipt>

          <Receipt term="one admin prompt">
            <p>
              Once, when the app launches. That prompt starts the root agent, which is also the
              forwarder. Adding, removing, renaming and re-porting aliases after it never ask for a
              password. A reboot clears <span className="mono">lo0</span>, so the next launch
              prompts again.
            </p>
          </Receipt>

          <Receipt term="nothing installed">
            <ul className="flex flex-col gap-1.5">
              <Absent>/Library/LaunchDaemons/*.plist</Absent>
              <Absent>SMAppService privileged helper</Absent>
              <Absent>sudo install script</Absent>
            </ul>
            <p className="mt-2.5">
              The root agent exits by itself when the app stops touching its liveness file, so
              quitting leaves nothing running as root — and needs no second prompt.
            </p>
          </Receipt>

          <Receipt term="what quitting leaves">
            <p>
              The <span className="mono">/etc/hosts</span> block and the{" "}
              <span className="mono">lo0</span> addresses, so your names still resolve.{" "}
              <span className="mono">make uninstall</span>, the tray&rsquo;s Uninstall item and the
              dashboard all run the same script and remove both behind one prompt.
            </p>
          </Receipt>
        </ul>
      </div>
    </FigureFrame>
  );
}
