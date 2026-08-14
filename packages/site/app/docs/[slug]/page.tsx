import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOC_PAGES, getDocPage } from "../../../lib/docs/pages.ts";
import { Section } from "../blocks.tsx";

/** Every doc page is known at build time, so all of them are static. */
export function generateStaticParams() {
  return DOC_PAGES.map((page) => ({ slug: page.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const page = getDocPage((await params).slug);
  if (page === null) return {};
  return {
    title: page.title,
    description: page.lede,
    alternates: { canonical: `/docs/${page.slug}` },
  };
}

export default async function DocPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const page = getDocPage((await params).slug);
  if (page === null) notFound();

  const index = DOC_PAGES.findIndex((candidate) => candidate.slug === page.slug);
  const next = DOC_PAGES[index + 1] ?? null;

  return (
    <article>
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">{page.title}</h1>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">{page.lede}</p>
      </header>

      {page.sections.length > 1 && (
        <nav aria-label="On this page" className="mb-9 border-y border-hairline py-3">
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
            {page.sections.map((section) => (
              <li key={section.id}>
                <a className="text-[12px] text-muted hover:text-ink" href={`#${section.id}`}>
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="flex flex-col gap-10">
        {page.sections.map((section) => (
          <Section key={section.id} section={section} />
        ))}
      </div>

      {next && (
        <div className="mt-14 border-t border-hairline pt-5">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Next</span>
          <Link className="mt-1.5 block text-[15px] font-medium tracking-tight text-ink hover:text-accent" href={`/docs/${next.slug}`}>
            {next.title}
          </Link>
        </div>
      )}
    </article>
  );
}
