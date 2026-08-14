/**
 * Every icon on the site, drawn on a 16x16 grid with a 1.4 stroke so they sit at
 * the same optical weight as the hairlines. No icon library.
 */
import type { ReactNode } from "react";

type IconProps = { className?: string };

function Svg({ children, className }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 3.5v-1h-8v8h1" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </Svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 3.5H3.5v9h9v-3" />
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 10.8v.2" />
    </Svg>
  );
}

/** Download: a tray with an arrow dropping into it. */
export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5v7.5M5 7.5 8 10.5 11 7.5" />
      <path d="M2.5 11.5v2h11v-2" />
    </Svg>
  );
}
