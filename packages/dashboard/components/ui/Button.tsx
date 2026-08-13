"use client";

import type { ComponentProps } from "react";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

// ComponentProps (not ButtonHTMLAttributes) so React 19 `ref` passes straight through.
export interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  size?: Size;
  /** Renders a spinner and disables the button. */
  busy?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink border border-accent hover:opacity-85",
  outline: "border border-hairline-strong text-ink bg-transparent hover:bg-sunken",
  ghost: "border border-transparent text-muted hover:text-ink hover:bg-sunken",
  danger: "border border-hairline-strong text-danger bg-transparent hover:bg-sunken",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-2",
};

export function Button({
  variant = "outline",
  size = "md",
  busy = false,
  className = "",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={[
        "inline-flex select-none items-center justify-center rounded-[2px] font-medium",
        "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(" ")}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** A rotating arc — the only spinner in the app. */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`animate-spin ${className}`}
    >
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.25" />
      <path
        d="M6 1.5A4.5 4.5 0 0 1 10.5 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface IconButtonProps extends ComponentProps<"button"> {
  /** Required: these buttons have no text. */
  label: string;
  tone?: "default" | "danger";
}

/** Square icon-only affordance used in alias rows. */
export function IconButton({
  label,
  tone = "default",
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      className={[
        "inline-flex h-8 w-8 items-center justify-center rounded-[2px] border border-transparent",
        "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger"
          ? "text-muted hover:border-hairline hover:text-danger"
          : "text-muted hover:border-hairline hover:text-ink",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
