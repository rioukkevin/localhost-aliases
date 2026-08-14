"use client";

/**
 * The docs rail. Client-side only because it needs the current path to mark the active
 * item; the active treatment is the app's own — a recessed pill plus a 2px accent tick.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export function DocsNav({ pages }: { pages: Array<{ slug: string; title: string }> }) {
  const pathname = usePathname();

  return (
    <ul className="mt-3 flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
      {pages.map((page) => {
        const href = `/docs/${page.slug}`;
        const active = pathname === href;
        return (
          <li key={page.slug}>
            <Link
              aria-current={active ? "page" : undefined}
              className={`relative block rounded-[2px] px-2.5 py-2 text-[13px] transition-colors duration-150 ${
                active ? "bg-sunken text-ink" : "text-muted hover:bg-sunken hover:text-ink"
              }`}
              href={href}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-2.5 bottom-0 h-[2px] bg-accent lg:inset-x-auto lg:left-0 lg:top-1/2 lg:h-4 lg:w-[2px] lg:-translate-y-1/2"
                />
              )}
              {page.title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
