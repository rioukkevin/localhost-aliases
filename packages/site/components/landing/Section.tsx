import type { ReactNode } from "react";

/**
 * One landing section: a caps eyebrow, an h1-weight heading, a lede, then content.
 * Sections are separated by a hairline — the site has no cards and no shadows.
 */
export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="border-t border-hairline">
      <div className="mx-auto w-full max-w-5xl px-4 py-12 md:px-8 md:py-16">
        <header className="mb-7">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{eyebrow}</p>
          <h2 className="mt-2 text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">
            {title}
          </h2>
          {lede ? (
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{lede}</p>
          ) : null}
        </header>
        {children}
      </div>
    </section>
  );
}

/** A hairline-ruled list of short statements. Used for limits and requirements. */
export function FactList({ items }: { items: { term: ReactNode; detail: ReactNode }[] }) {
  return (
    <ul className="divide-y divide-hairline border-y border-hairline">
      {items.map((item, index) => (
        <li key={index} className="flex flex-wrap gap-x-8 gap-y-1 py-3.5">
          <span className="w-full text-[13px] font-medium text-ink sm:w-[16rem] sm:shrink-0">
            {item.term}
          </span>
          <span className="max-w-2xl flex-1 text-[13px] leading-relaxed text-muted">
            {item.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
