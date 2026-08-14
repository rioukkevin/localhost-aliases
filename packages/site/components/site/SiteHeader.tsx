import Link from "next/link";
import { AppMark, WordMark } from "../ui/AppMark.tsx";
import { IconExternal } from "../ui/Icons.tsx";
import { GITHUB_URL, NAV_LINKS } from "./links.ts";

/**
 * Marketing chrome, deliberately lighter than the app's NavRail: one row, no
 * active state to track, no client JS.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-canvas">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-4 py-3 md:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Localhost Aliases — home">
          <AppMark className="text-accent" />
          <WordMark />
        </Link>

        <nav className="ml-auto flex items-center gap-1" aria-label="Site">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-[2px] px-2.5 py-2 text-[13px] text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-[2px] px-2.5 py-2 text-[13px] text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            GitHub
            <IconExternal />
          </a>
        </nav>
      </div>
    </header>
  );
}
