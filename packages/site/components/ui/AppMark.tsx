/** The product mark: a patch jack with a cable leaving it. Same 22x22 as the app's. */
export function AppMark({ className = "" }: { className?: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="7" cy="11" r="5.5" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      <circle cx="7" cy="11" r="2" fill="currentColor" />
      <path
        d="M12.5 11h3.2a2.3 2.3 0 0 0 2.3-2.3V4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="18" cy="3" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** The wordmark, set in mono like every other machine-literal string. */
export function WordMark({ className = "" }: { className?: string }) {
  return (
    <span className={`mono text-[13px] font-medium tracking-tight text-ink ${className}`}>
      localhost<span className="text-faint">-</span>aliases
    </span>
  );
}
