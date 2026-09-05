"use client";

import { useRef, type ReactNode } from "react";
import { FigureFrame } from "./FigureFrame.tsx";
import { useRevealStep } from "./useRevealStep.ts";

/**
 * The mechanism, as one request falling down the page.
 *
 * Five rows on one wire: the name you type, the lookup that turns it into an
 * address, the address the root agent holds, the splice, and the dev server you
 * already started. Scrolling lights them in order — the emphasis moves, never
 * the content: every row is complete text at every step, so a reader with
 * JavaScript off, or one who lands mid-page, gets the whole chain anyway.
 *
 * `kind` is the honest distinction the drawing has to keep. A jack is a place
 * bytes actually arrive; a cable is what happens between two of them. `/etc/hosts`
 * is a lookup, not a hop, so it is drawn as a cable rather than as a third
 * address on the wire.
 */
interface Row {
  kind: "jack" | "cable";
  /** The machine-literal this row is, in the app's own vocabulary. */
  value: ReactNode;
  label: string;
  detail: ReactNode;
}

const ROWS: Row[] = [
  {
    kind: "jack",
    value: (
      <>
        http://myapp<span className="text-muted">.test</span>
      </>
    ),
    label: "you type a name",
    detail: "The browser asks the system for the address behind that name, exactly as it would for any site.",
  },
  {
    kind: "cable",
    value: "/etc/hosts",
    label: "the name resolves",
    detail: (
      <>
        One line, in the block the app owns, answers with <span className="mono">127.0.0.2</span> — an address it
        added to <span className="mono">lo0</span>. Names resolve to addresses and never to ports, which is why each
        alias needs one of its own.
      </>
    ),
  },
  {
    kind: "jack",
    value: "127.0.0.2:80",
    label: "the root agent is listening",
    detail: (
      <>
        One process, started by the prompt at launch, holds <span className="mono">:80</span> there. The address
        alone says which alias this is.
      </>
    ),
  },
  {
    kind: "cable",
    value: "raw TCP",
    label: "the bytes are copied across",
    detail: (
      <>
        No <span className="mono">Host</span> header is read, nothing is rewritten, nothing is logged — the bytes are
        never looked at. HMR and WebSockets pass straight through.
      </>
    ),
  },
  {
    kind: "jack",
    value: "127.0.0.1:3000",
    label: "your dev server answers",
    detail: "Exactly as you started it, on the port it already had. It never learns that any of this happened.",
  },
];

/** The jack a wire terminates in: the app's own connector, drawn small. */
function Jack({ lit }: { lit: boolean }) {
  return (
    <span aria-hidden="true" className="relative flex h-6 w-6 shrink-0 items-center justify-center">
      <span className="absolute inset-0 rounded-full border border-current opacity-50" />
      <span className={`block rounded-full bg-current ${lit ? "h-2.5 w-2.5" : "h-1.5 w-1.5"}`} />
    </span>
  );
}

/**
 * The wire between two jacks. Percentage geometry with no viewBox, exactly like
 * PatchCable, so the dash pattern stays pixel-constant however tall the row is.
 */
function Wire({ lit, packet }: { lit: boolean; packet: boolean }) {
  return (
    <span className="relative w-full flex-1">
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full" focusable="false" role="presentation">
        <line
          className={lit ? "cable-live" : ""}
          opacity={lit ? 1 : 0.5}
          stroke="currentColor"
          strokeDasharray="5 5"
          strokeLinecap="round"
          strokeWidth="1.25"
          x1="50%"
          x2="50%"
          y1="0"
          y2="100%"
        />
      </svg>
      {packet && lit ? <span aria-hidden="true" className="la-drop" /> : null}
    </span>
  );
}

export function FlowSchema() {
  const track = useRef<HTMLDivElement>(null);
  const step = useRevealStep(track, ROWS.length);

  return (
    <div ref={track}>
      <FigureFrame
        caption={
          <>
            Two hops and a lookup. <span className="mono">/etc/hosts</span> answers{" "}
            <span className="mono">myapp.test</span> with <span className="mono">127.0.0.2</span>, an address on{" "}
            <span className="mono">lo0</span>; the root agent holds <span className="mono">:80</span> there and copies
            raw bytes to <span className="mono">127.0.0.1:3000</span>. Nothing on the second hop is parsed, which is
            why HMR and WebSockets need no configuration — and why the same wire can carry{" "}
            <span className="mono">https://</span> once a certificate exists for the name.
          </>
        }
        label="one request, end to end"
        meta="myapp.test → 127.0.0.1:3000"
      >
        <ol className="flex flex-col">
          {ROWS.map((row, index) => {
            const lit = index <= step;
            const current = index === step;
            const last = index === ROWS.length - 1;

            return (
              <li
                className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 md:grid-cols-[3rem_minmax(0,1fr)] md:gap-x-5"
                key={row.label}
              >
                <div
                  className={`flex flex-col items-center transition-colors duration-500 ${
                    lit ? "text-live" : "text-faint"
                  }`}
                >
                  {row.kind === "jack" ? <Jack lit={lit} /> : null}
                  {last ? null : <Wire lit={lit} packet={row.kind === "cable"} />}
                </div>

                <div className={last ? "min-w-0" : "min-w-0 pb-7"}>
                  <p
                    className={`text-[10px] font-medium uppercase tracking-[0.16em] transition-colors duration-500 ${
                      current ? "text-accent" : lit ? "text-muted" : "text-faint"
                    }`}
                  >
                    <span className="mono">{index + 1}</span> · {row.label}
                  </p>
                  <p
                    className={`mono mt-1 text-[15px] font-medium leading-tight transition-colors duration-500 md:text-[17px] ${
                      lit ? "text-ink" : "text-muted"
                    }`}
                  >
                    {row.value}
                  </p>
                  <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">{row.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </FigureFrame>
    </div>
  );
}
