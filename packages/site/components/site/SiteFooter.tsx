import Link from "next/link";
import { AppMark, WordMark } from "../ui/AppMark.tsx";
import { GITHUB_ISSUES_URL, GITHUB_URL, NAV_LINKS } from "./links.ts";

export function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-canvas">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-start gap-x-10 gap-y-6 px-4 py-8 md:px-8">
        <div className="min-w-[14rem]">
          <div className="flex items-center gap-2.5">
            <AppMark className="text-accent" />
            <WordMark />
          </div>
          <p className="mono mt-2 text-[10px] leading-relaxed text-faint">
            127.0.0.1
            <br />
            names → ports
          </p>
        </div>

        <nav className="flex flex-col gap-2" aria-label="Footer">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13px] text-muted transition-colors duration-150 hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13px] text-muted transition-colors duration-150 hover:text-ink"
          >
            Source
          </a>
          <a
            href={GITHUB_ISSUES_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13px] text-muted transition-colors duration-150 hover:text-ink"
          >
            Issues
          </a>
        </nav>

        <p className="ml-auto max-w-xs text-[11px] leading-relaxed text-faint">
          Runs entirely on your machine. Every address it creates is loopback, so nothing is
          reachable from your network or the internet.
        </p>
      </div>
    </footer>
  );
}
