"use client";

import { useState } from "react";
import { IconCheck, IconCopy } from "./Icons.tsx";

const RESET_MS = 1600;

/** Copies a literal string and flips to a check for a moment. */
export function CopyButton({
  value,
  what = "value",
  className = "",
}: {
  value: string;
  what?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={copied ? `Copied ${what}` : `Copy ${what}`}
      className={`inline-flex h-8 shrink-0 select-none items-center gap-1.5 rounded-[2px] border border-hairline-strong px-2.5 text-[12px] text-muted transition-colors duration-150 hover:text-ink ${className}`}
      onClick={() => {
        // No clipboard on insecure origins or old browsers: stay silent rather than throw.
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), RESET_MS);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <IconCheck className="text-live" /> : <IconCopy />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
