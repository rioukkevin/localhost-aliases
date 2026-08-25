import type { ReactNode } from "react";
import { PatchCable } from "../ui/PatchCable.tsx";
import { FigureFrame } from "./FigureFrame.tsx";

/**
 * The mechanism as one continuous chain: what you type, the address it resolves
 * to, and the port your dev server already has. Two links, three endpoints, read
 * left to right — drawn with the app's own patch cable rather than a second
 * visual language.
 *
 * The moving dot is the request, and it runs the links in order: both share one
 * 5.2s cycle and the second starts halfway through it, so the eye follows the
 * name to the address and only then the address to the port. Everything that
 * carries meaning is text, so the drawing is complete the instant it paints and
 * loses nothing when the motion is switched off.
 */
const CYCLE_MS = 5200;

function Endpoint({
  value,
  note,
  className = "",
}: {
  value: ReactNode;
  note: ReactNode;
  className?: string;
}) {
  return (
    <div className={`shrink-0 text-center ${className}`}>
      <p className="mono text-[15px] font-medium leading-tight text-ink md:text-[17px]">{value}</p>
      <p className="mx-auto mt-1.5 max-w-[16rem] text-[11px] leading-snug text-faint">{note}</p>
    </div>
  );
}

function Link({
  step,
  label,
  note,
  delayMs,
}: {
  step: number;
  label: string;
  note: ReactNode;
  delayMs: number;
}) {
  return (
    <div className="min-w-0 grow">
      <p className="text-center text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
        <span className="mono text-muted">{step}</span> · {label}
      </p>

      <div className="relative h-7">
        <PatchCable status="up" />
        <span
          aria-hidden="true"
          className="la-packet"
          style={{ animationDelay: `${delayMs}ms`, animationDuration: `${CYCLE_MS}ms` }}
        />
      </div>

      <p className="mono text-center text-[11px] leading-snug text-faint">{note}</p>
    </div>
  );
}

export function MechanismFigure() {
  return (
    <FigureFrame
      label="the mechanism"
      meta="myapp.test → 127.0.0.1:3000"
      caption={
        <>
          Two links. <span className="mono">/etc/hosts</span> answers{" "}
          <span className="mono">myapp.test</span> with <span className="mono">127.0.0.2</span>, an
          address the app adds to <span className="mono">lo0</span>; the root agent listens on{" "}
          <span className="mono">127.0.0.2:80</span> and copies raw bytes to{" "}
          <span className="mono">127.0.0.1:3000</span>. Nothing on the second link is parsed — no{" "}
          <span className="mono">Host</span> header is read or rewritten — which is why WebSockets
          and HMR need no configuration, and why nothing in the path can present a TLS certificate
          for the name.
        </>
      }
    >
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-4">
        <Endpoint
          className="lg:w-[10rem]"
          value={
            <>
              myapp<span className="text-faint">.test</span>
            </>
          }
          note="what you type"
        />

        <Link step={1} label="resolve" note="/etc/hosts" delayMs={0} />

        <Endpoint
          className="lg:w-[12rem]"
          value="127.0.0.2:80"
          note={
            <>
              an <span className="mono">lo0</span> alias, loopback only — the root agent listens
              here
            </>
          }
        />

        <Link step={2} label="forward" note="raw TCP" delayMs={CYCLE_MS / 2} />

        <Endpoint
          className="lg:w-[12rem]"
          value="127.0.0.1:3000"
          note="your dev server, exactly as you started it"
        />
      </div>
    </FigureFrame>
  );
}
