import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * A navigation that looks like a Button. Kept separate from Button so a link is never
 * a <button> inside an <a>; the class recipe is the same one Button uses.
 */
const VARIANTS = {
  primary: "bg-accent text-accent-ink border border-accent hover:opacity-85",
  outline: "border border-hairline-strong text-ink bg-transparent hover:bg-sunken",
  ghost: "border border-transparent text-muted hover:text-ink hover:bg-sunken",
} as const;

const SIZES = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-2",
} as const;

export interface LinkButtonProps extends ComponentProps<typeof Link> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}

export function LinkButton({
  variant = "outline",
  size = "md",
  className = "",
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      {...rest}
      className={[
        "inline-flex select-none items-center justify-center rounded-[2px] font-medium",
        "transition-colors duration-150",
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(" ")}
    >
      {children}
    </Link>
  );
}
