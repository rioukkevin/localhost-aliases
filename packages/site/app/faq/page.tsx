import type { Metadata } from "next";
import Link from "next/link";
import { FAQ_ITEMS } from "../../lib/faq.ts";
import { Block } from "../docs/blocks.tsx";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "What runs as root and for how long, why project aliases are http:// only, why .test and not .local, WebSockets and HMR, reboots, uninstalling, signing, and Apple Silicon.",
  alternates: { canonical: "/faq" },
};

const LINK = "text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent";

/**
 * Answers, not reassurance. Every claim is checked against the code in lib/faq.ts, and the
 * ones with an uncomfortable answer — the root agent's tradeoff, the missing signature — are
 * the reason the page exists at all.
 *
 * Plain server-rendered sections rather than <details>: an answer you have to click to see is
 * an answer nobody reads, nothing here is long enough to need folding, and every anchor is
 * linkable with no JavaScript at all.
 */
export default function FaqPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">FAQ</h1>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
          The questions a sceptical developer asks before typing a password into something that edits{" "}
          <span className="mono">/etc/hosts</span> as root. Answered from the code, including where the answer is
          uncomfortable.
        </p>
      </header>

      <nav aria-label="Questions" className="mb-8 border border-hairline bg-canvas">
        <p className="border-b border-hairline bg-raised px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.18em] text-faint md:px-6">
          Questions
        </p>
        <ol className="divide-y divide-hairline">
          {FAQ_ITEMS.map((item, i) => (
            <li key={item.id}>
              <a
                className="flex gap-3 px-4 py-2.5 text-[13px] leading-relaxed text-muted transition-colors duration-150 hover:bg-raised hover:text-ink md:px-6"
                href={`#${item.id}`}
              >
                <span className="mono w-5 shrink-0 text-right text-[11px] text-faint">{i + 1}</span>
                <span className="min-w-0">{item.question}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex flex-col gap-8">
        {FAQ_ITEMS.map((item, i) => (
          <section
            aria-labelledby={`${item.id}-title`}
            className="scroll-mt-20 border border-hairline bg-canvas"
            id={item.id}
            key={item.id}
          >
            <header className="flex items-baseline gap-3 border-b border-hairline bg-raised px-4 py-3 md:px-6">
              <span aria-hidden="true" className="mono w-5 shrink-0 text-right text-[11px] text-faint">
                {i + 1}
              </span>
              <h2 className="text-[15px] font-semibold tracking-tight text-ink" id={`${item.id}-title`}>
                {item.question}
              </h2>
            </header>

            <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
              {item.blocks.map((block, j) => (
                <Block block={block} key={j} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-muted">
        Still unanswered? The{" "}
        <Link className={LINK} href="/docs">
          docs
        </Link>{" "}
        go further, and{" "}
        <Link className={LINK} href="/docs/troubleshooting">
          troubleshooting
        </Link>{" "}
        covers what to check when a name does not resolve.
      </p>
    </div>
  );
}
