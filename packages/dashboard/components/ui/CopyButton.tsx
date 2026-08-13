"use client";

import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/client/commands.ts";
import { IconCheck, IconCopy } from "./Icons.tsx";
import { IconButton } from "./Button.tsx";

export interface CopyButtonProps {
  value: string;
  /** What is being copied, e.g. "URL" — used in the accessible label. */
  what?: string;
  /** Renders text next to the icon instead of an icon-only square. */
  withLabel?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function CopyButton({
  value,
  what = "value",
  withLabel = false,
  className = "",
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onClick() {
    const ok = await copyText(value);
    setCopied(ok);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  const label = copied ? `Copied ${what}` : `Copy ${what}`;

  if (withLabel) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        data-testid={rest["data-testid"]}
        className={[
          "inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-hairline-strong px-2.5",
          "text-[12px] text-muted transition-colors hover:text-ink",
          className,
        ].join(" ")}
      >
        {copied ? <IconCheck className="text-live" /> : <IconCopy />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    );
  }

  return (
    <IconButton
      label={label}
      onClick={onClick}
      data-testid={rest["data-testid"]}
      className={className}
    >
      {copied ? <IconCheck className="text-live" /> : <IconCopy />}
    </IconButton>
  );
}
