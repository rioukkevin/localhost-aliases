"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppMark } from "./AppMark.tsx";

const ITEMS = [
  { href: "/", label: "Aliases", testId: "nav-aliases" },
  { href: "/projects", label: "Projects", testId: "nav-projects" },
  { href: "/settings", label: "Settings", testId: "nav-settings" },
  { href: "/mcp", label: "MCP", testId: "nav-mcp" },
] as const;

/**
 * One nav element for both layouts: a horizontal bar below 1024px, a fixed left
 * rail above it. Duplicating the markup per breakpoint would duplicate the
 * data-testids, which would make every e2e selector ambiguous.
 */
export function NavRail() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 z-30 flex items-center gap-4 border-b border-hairline bg-canvas px-4 py-3 lg:fixed lg:inset-y-0 lg:left-0 lg:w-56 lg:flex-col lg:items-stretch lg:gap-8 lg:border-b-0 lg:border-r lg:px-4 lg:py-6">
      <Link
        href="/"
        aria-label="localhost-aliases — dashboard home"
        className="flex shrink-0 items-center gap-2.5 text-ink"
      >
        <AppMark className="text-accent" />
        <span className="mono hidden text-[13px] font-medium tracking-tight sm:block">
          localhost<span className="text-faint">-</span>aliases
        </span>
      </Link>

      <nav
        aria-label="Sections"
        className="-mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 lg:mx-0 lg:flex-none lg:flex-col lg:items-stretch lg:overflow-visible lg:px-0"
      >
        {ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={item.testId}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={[
                "relative shrink-0 rounded-[2px] px-2.5 py-2 text-[13px] transition-colors",
                active ? "bg-sunken text-ink" : "text-muted hover:bg-sunken hover:text-ink",
              ].join(" ")}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-x-2.5 bottom-0 h-[2px] lg:inset-x-auto lg:left-0 lg:top-1/2 lg:h-4 lg:w-[2px] lg:-translate-y-1/2 ${
                  active ? "bg-accent" : "bg-transparent"
                }`}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <p className="mono mt-auto hidden text-[10px] leading-relaxed text-faint lg:block">
        127.0.0.1
        <br />
        names → ports
      </p>
    </aside>
  );
}
