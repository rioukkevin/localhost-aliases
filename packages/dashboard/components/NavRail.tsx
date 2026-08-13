"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppMark } from "./ui/AppMark.tsx";

const ITEMS = [
  { href: "/", label: "Aliases" },
  { href: "/projects", label: "Projects" },
  { href: "/onboarding", label: "Setup" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * One element, two layouts: a sticky bar under 1024px, a fixed 14rem rail above it.
 * Deliberately not duplicated markup — two copies would mean two of every nav item.
 */
export function NavRail() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      aria-label="Primary"
      className={[
        "sticky top-0 z-30 flex items-center gap-4 border-b border-hairline bg-canvas px-4 py-3",
        "lg:fixed lg:inset-y-0 lg:left-0 lg:w-56 lg:flex-col lg:items-stretch lg:gap-8",
        "lg:border-b-0 lg:border-r lg:px-4 lg:py-6",
      ].join(" ")}
    >
      <Link href="/" className="flex items-center gap-2 rounded-[2px]">
        <AppMark className="text-accent" />
        <span className="mono hidden text-[13px] font-medium tracking-tight sm:inline">
          localhost<span className="text-faint">-</span>aliases
        </span>
      </Link>

      <ul className="flex items-center gap-1 lg:flex-col lg:items-stretch lg:gap-0.5">
        {ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="relative">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                data-testid={`nav-${item.label.toLowerCase()}`}
                className={[
                  "block rounded-[2px] px-2.5 py-2 text-[13px] transition-colors duration-150",
                  active ? "bg-sunken text-ink" : "text-muted hover:bg-sunken hover:text-ink",
                ].join(" ")}
              >
                {item.label}
              </Link>
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2.5 bottom-0 h-[2px] bg-accent lg:inset-x-auto lg:left-0 lg:top-1/2 lg:h-4 lg:w-[2px] lg:-translate-y-1/2"
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="mono mt-auto hidden text-[10px] leading-relaxed text-faint lg:block">
        127.0.0.1
        <br />
        names → ports
      </p>
    </nav>
  );
}
