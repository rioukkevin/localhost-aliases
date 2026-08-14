/**
 * The docs shell: the content column plus a rail listing every page.
 *
 * The rail is the same list as the index, so a reader never has to go back to /docs to move
 * on. It collapses above the content below `lg` rather than becoming a second navigation
 * pattern.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { DOC_PAGES } from "../../lib/docs/pages.ts";
import { DocsNav } from "./nav.tsx";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
        <nav aria-label="Documentation" className="lg:w-[13rem] lg:shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">Docs</p>
          <DocsNav pages={DOC_PAGES.map((page) => ({ slug: page.slug, title: page.title }))} />
          <p className="mono mt-6 hidden text-[10px] leading-relaxed text-faint lg:block">
            127.0.0.1
            <br />
            names → ports
          </p>
        </nav>

        {/* Not a <main>: the root layout owns that landmark and its skip-link target. */}
        <div className="min-w-0 flex-1">{children}</div>
      </div>

      {/* A bare "Changelog" under a rule reads as a stray link, not as a destination. The
          caps label puts it in the same grammar as every other rack label in the app, and
          the trailing clause says what is on the other side of it. */}
      <footer className="mt-14 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hairline pt-5">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Releases</span>
        <p className="text-[12px] text-muted">
          <Link
            className="text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent"
            href="/changelog"
          >
            Changelog
          </Link>{" "}
          — every published build, with the checksum of the file you download.
        </p>
      </footer>
    </div>
  );
}
