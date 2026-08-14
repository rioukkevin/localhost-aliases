import type { Metadata } from "next";
import Link from "next/link";
import { Panel } from "../../components/ui/Panel.tsx";
import { DOC_PAGES } from "../../lib/docs/pages.ts";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How Localhost Aliases works: installation, the one admin prompt, loopback addresses, projects, the MCP server, uninstalling and troubleshooting.",
  alternates: { canonical: "/docs" },
};

export default function DocsIndexPage() {
  return (
    <>
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">Documentation</h1>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
          Everything the app does to your Mac, written down. Read{" "}
          <Link
            className="text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-accent"
            href="/docs/first-run"
          >
            first run
          </Link>{" "}
          before you type your password into anything.
        </p>
      </header>

      <Panel meta={`${DOC_PAGES.length} pages`} padded={false} title="Contents">
        <ul className="divide-y divide-hairline">
          {DOC_PAGES.map((page) => (
            <li key={page.slug}>
              <Link
                className="block px-4 py-4 transition-colors duration-150 hover:bg-raised md:px-6"
                href={`/docs/${page.slug}`}
              >
                <span className="text-[15px] font-medium tracking-tight text-ink">{page.title}</span>
                <span className="mt-1 block max-w-2xl text-[13px] leading-relaxed text-muted">{page.lede}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
