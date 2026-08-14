/**
 * Every icon in the app, drawn on a 16x16 grid with a 1.4 stroke so they sit at
 * the same optical weight as the hairlines. No icon library.
 */
type IconProps = { className?: string };

function Svg({ children, className }: IconProps & { children: React.ReactNode }) {
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

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9" />
    </Svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11.2 2.8 13.2 4.8 5.5 12.5 2.8 13.2 3.5 10.5z" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
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

/** Detach: a patch cable pulled apart in the middle. */
export function IconUnlink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 9.8 4.8 11.2a2.4 2.4 0 0 1-3.4-3.4l1.4-1.4" />
      <path d="M9.8 6.2l1.4-1.4a2.4 2.4 0 0 1 3.4 3.4l-1.4 1.4" />
      <path d="M12.5 2.2v1.6M2.2 12.5h1.6M13.8 12.2l1.1 1.1M2.2 3.8 1.1 2.7" />
    </Svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.8 12.5v-9h4l1.4 2h7v7z" />
    </Svg>
  );
}

/** Settings: a cog — inner hub plus eight teeth on the same 16x16 grid. */
export function IconGear(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
    </Svg>
  );
}
