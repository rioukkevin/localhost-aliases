import Link from "next/link";
import type { ReactNode } from "react";
import { IconLock } from "../ui/Icons.tsx";
import { FigureMotion } from "./FigureMotion.tsx";

/**
 * Three reasons, three drawings. Each tile is a picture first and two lines of
 * prose second — the argument should survive being skimmed, and none of these
 * three needs a paragraph to land.
 *
 * The scan in the first tile is the only loop here: it is doing the thing the
 * copy describes, which is opening tabs until one of them is the right project.
 */
const PORTS = ["localhost:3000", "localhost:5173", "localhost:8080"];

/** One 6s cycle, staggered, so exactly one tab is "open" at a time. */
const STEP_MS = 1500;

const LINK = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";

function Tile({ glyph, title, children }: { glyph: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col border border-hairline bg-canvas">
      <div className="flex h-[9.5rem] items-center justify-center border-b border-hairline bg-sunken px-4">
        {glyph}
      </div>
      <div className="px-4 py-4">
        <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

/** Tabs being opened in turn, then the one that never needed opening. */
function TabsGlyph() {
  return (
    <ul className="flex w-full max-w-[13rem] flex-col gap-1.5">
      {PORTS.map((port, index) => (
        <li
          className="la-probe mono border border-hairline bg-sunken px-2 py-1 text-[11px] text-muted"
          key={port}
          style={{ animationDelay: `${index * STEP_MS}ms` }}
        >
          {port}
        </li>
      ))}
      <li className="relative border border-hairline-strong bg-raised px-2 py-1">
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
        <span className="mono text-[11px] text-ink">
          shop<span className="text-muted">.test</span>
        </span>
      </li>
    </ul>
  );
}

/** One jar for every port, against one jar each. */
function CookieGlyph() {
  return (
    <div className="flex w-full max-w-[13rem] flex-col gap-2">
      <div className="border border-hairline bg-canvas px-2 py-1.5">
        <p className="mono text-[11px] text-muted">
          localhost<span className="text-faint">:3000 :3001 :5173</span>
        </p>
        <p className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.14em] text-down">
          one cookie jar, last writer wins
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {["shop.test", "api.test"].map((name, index) => (
          <div
            className="la-reveal border border-hairline bg-canvas px-2 py-1.5"
            key={name}
            style={{ animationDelay: `${240 + index * 160}ms` }}
          >
            <p className="mono text-[11px] text-ink">{name}</p>
            <p className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.14em] text-live">its own</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Both schemes bound at once, which is what turning it on actually does. */
function TlsGlyph() {
  return (
    <div className="flex w-full max-w-[13rem] flex-col gap-2">
      <div className="la-reveal flex items-center gap-2 border border-hairline-strong bg-raised px-2 py-1.5">
        <IconLock className="shrink-0 text-live" />
        <span className="mono text-[11.5px] text-ink">https://myapp.test</span>
      </div>
      <div className="flex items-center gap-2 border border-hairline bg-canvas px-2 py-1.5">
        <span className="mono text-[11.5px] text-muted">http://myapp.test</span>
        <span className="ml-auto whitespace-nowrap text-[9.5px] font-medium uppercase tracking-[0.14em] text-faint">
          still bound
        </span>
      </div>
    </div>
  );
}

export function ValueTiles() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FigureMotion />

      <Tile glyph={<TabsGlyph />} title="A name you can read">
        Five tabs on five ports look identical, so you open them in turn until one is the project you meant. Named,
        the tab bar is an index — and history, autofill and bookmarks key on something that means the project.
      </Tile>

      <Tile glyph={<CookieGlyph />} title="One origin per project">
        Cookies ignore the port, so everything you serve from <span className="mono">localhost</span> shares a single
        jar and two apps that both set <span className="mono">session</span> quietly overwrite each other. Each alias
        is its own origin.
      </Tile>

      <Tile glyph={<TlsGlyph />} title="https:// when you want it">
        Off by default. Turn it on and every alias also answers over TLS, certificate issued and renewed for you,
        with <span className="mono">http://</span> still bound.{" "}
        <Link className={LINK} href="/faq#https">
          One step stays manual
        </Link>
        , on purpose.
      </Tile>
    </div>
  );
}
