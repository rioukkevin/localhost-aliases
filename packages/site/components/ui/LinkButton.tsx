import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink border border-accent hover:opacity-85",
  outline: "border border-hairline-strong text-ink bg-transparent hover:bg-sunken",
  ghost: "border border-transparent text-muted hover:text-ink hover:bg-sunken",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-2",
  lg: "h-11 px-5 text-[14px] gap-2",
};

const BASE =
  "inline-flex select-none items-center justify-center rounded-[2px] font-medium transition-colors duration-150";

/**
 * The Button shape from the app, as an anchor. The site never submits anything,
 * so every affordance here is a link — no client JS for navigation.
 */
export function LinkButton({
  href,
  variant = "outline",
  size = "md",
  external = false,
  className = "",
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  external?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;

  if (external || href.startsWith("http")) {
    return (
      <a href={href} className={classes} rel="noreferrer noopener" target="_blank">
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
