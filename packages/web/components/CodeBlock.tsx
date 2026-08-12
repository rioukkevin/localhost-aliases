"use client";

import { CopyButton } from "./CopyButton.tsx";

export interface CodeBlockProps {
  value: string;
  /** Used in the copy button's accessible label, e.g. "command". */
  what?: string;
  /** Quiet caption above the box, e.g. "check" / "disable". */
  label?: string;
  className?: string;
  "data-testid"?: string;
}

/**
 * Copyable literal text: shell commands, JSON/TOML snippets, file paths.
 * Same sunken box as the helper banner's command, so commands look identical
 * everywhere in the app.
 */
export function CodeBlock({ value, what = "snippet", label, className = "", ...rest }: CodeBlockProps) {
  return (
    <div className={className}>
      {label ? (
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          {label}
        </p>
      ) : null}
      <div
        data-testid={rest["data-testid"]}
        className="flex items-stretch border border-hairline-strong bg-sunken"
      >
        {/* pre-wrap, not pre: a `sudo security …` one-liner is longer than any
            column here, and a silently clipped command is a broken command. */}
        <pre className="mono min-w-0 flex-1 whitespace-pre-wrap break-words px-3 py-2.5 text-[12px] leading-relaxed text-ink">
          {value}
        </pre>
        <CopyButton
          value={value}
          what={what}
          withLabel
          className="m-1 shrink-0 self-start border-0 bg-transparent"
        />
      </div>
    </div>
  );
}
