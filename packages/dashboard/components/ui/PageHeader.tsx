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

/** The page body column. Same max-width and padding as the Aliases view. */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">{children}</div>
  );
}
