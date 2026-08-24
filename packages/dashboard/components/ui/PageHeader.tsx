import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

/**
 * The h1 + lede of every view. Extracted from app/page.tsx so the four pages
 * cannot drift apart typographically.
 */
export function PageHeader({ title, children }: PageHeaderProps) {
  return (
    <header className="mb-7">
      <h1 className="text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">{title}</h1>
      {children ? (
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">{children}</p>
      ) : null}
    </header>
  );
}

/**
 * The page body column. Same max-width and padding as the Aliases view.
 *
 * The generous bottom padding is not decoration: the status indicator is `fixed` in the
 * bottom-right corner, so whatever sits at the very end of the document can never be
 * scrolled out from under it. Before this, the create form's Port field was the last
 * thing on the home page and the lamp sat on top of it — clicking the right-hand half of
 * that field opened the status panel instead of focusing the input.
 */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-8 md:px-8 md:pb-32 md:pt-10">
      {children}
    </div>
  );
}
