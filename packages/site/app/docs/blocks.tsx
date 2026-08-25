/**
 * The docs renderer. Knows about block kinds and nothing about the subject matter.
 *
 * Everything is a server component: the docs are static text and a copy button is not worth
 * shipping a client bundle for. Machine-literal text — hostnames, ports, paths, commands —
 * is monospace, per the design language; prose is not.
 */
import Link from "next/link";
import { Banner } from "../../components/ui/Banner.tsx";
import { CodeBlock } from "../../components/ui/CodeBlock.tsx";
import type { DocBlock, DocSection } from "../../lib/docs/schema.ts";
import { tokenizeInline } from "../../lib/docs/schema.ts";

const CAPS = "text-[10px] font-medium uppercase tracking-[0.16em] text-faint";

/**
 * Only same-origin paths and http(s) are linkable. The changelog feeds release notes through
 * this renderer, and those come off the network — a `javascript:` href must never reach an
 * anchor.
 */
function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}

export function Inline({ text }: { text: string }) {
  return (
    <>
      {tokenizeInline(text).map((token, i) => {
        if (token.kind === "code") {
          return (
            <code key={i} className="mono rounded-[2px] bg-sunken px-1 py-[1px] text-[0.92em] text-ink">
              {token.text}
            </code>
          );
        }
        if (token.kind === "strong") {
          return (
            <strong key={i} className="font-semibold text-ink">
              {token.text}
            </strong>
          );
        }
        if (token.kind === "link") {
          const href = safeHref(token.href);
          if (href === null) return <span key={i}>{token.text}</span>;
          const className = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";
          return href.startsWith("/") ? (
            <Link className={className} href={href} key={i}>
              {token.text}
            </Link>
          ) : (
            <a className={className} href={href} key={i} rel="noreferrer" target="_blank">
              {token.text}
            </a>
          );
        }
        return <span key={i}>{token.text}</span>;
      })}
    </>
  );
}

/**
 * One block. Exported because /faq renders the same block model through the same renderer —
 * a second markdown-ish renderer for the same six shapes would be a second thing to keep
 * honest.
 */
export function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case "p":
      return (
        <p className="text-[13px] leading-relaxed text-muted">
          <Inline text={block.text} />
        </p>
      );

    case "list":
      return (
        <ul className="flex flex-col gap-2">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-muted">
              <span aria-hidden className="mt-[9px] h-px w-3 shrink-0 bg-hairline-strong" />
              <span className="min-w-0">
                <Inline text={item} />
              </span>
            </li>
          ))}
        </ul>
      );

    case "steps":
      return (
        <ol className="flex flex-col gap-3">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-muted">
              <span className="mono mt-[2px] w-5 shrink-0 text-right text-[11px] text-faint">{i + 1}</span>
              <span className="min-w-0">
                <Inline text={item} />
              </span>
            </li>
          ))}
        </ol>
      );

    case "code":
      return <CodeBlock label={block.label} value={block.value} what={block.label ?? "snippet"} />;

    case "figure":
      return (
        <figure className="flex flex-col gap-1.5">
          <div className="border border-hairline bg-sunken">
            <pre className="mono overflow-x-auto px-3 py-3.5 text-[12px] leading-relaxed text-muted">{block.value}</pre>
          </div>
          {block.caption && <figcaption className={CAPS}>{block.caption}</figcaption>}
        </figure>
      );

    case "note":
      return (
        <Banner title={block.title} tone={block.tone}>
          <Inline text={block.text} />
        </Banner>
      );

    case "table":
      return (
        <div className="overflow-x-auto border border-hairline">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="bg-raised">
                {block.head.map((cell, i) => (
                  <th key={i} className={`border-b border-hairline px-3 py-2 ${CAPS}`} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-hairline last:border-b-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-2.5 align-top leading-relaxed text-muted">
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Section({ section }: { section: DocSection }) {
  return (
    <section aria-labelledby={`${section.id}-title`} className="scroll-mt-24" id={section.id}>
      <h2 className="text-[15px] font-semibold tracking-tight text-ink" id={`${section.id}-title`}>
        {section.title}
      </h2>
      <div className="mt-4 flex flex-col gap-5">
        {section.blocks.map((block, i) => (
          <Block block={block} key={i} />
        ))}
      </div>
    </section>
  );
}
