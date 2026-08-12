"use client";

import { useId } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Screen-reader-only label, for dense rows. */
  hideLabel?: boolean;
  "data-testid"?: string;
}

/** A real switch: role=switch, space/enter operable, visible focus ring. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  hideLabel = false,
  ...rest
}: ToggleProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={hideLabel ? undefined : id}
        aria-label={hideLabel ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        data-testid={rest["data-testid"]}
        className={[
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-40",
          checked ? "border-accent bg-accent-dim" : "border-hairline-strong bg-sunken",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "block h-3 w-3 rounded-full transition-transform duration-150",
            checked ? "translate-x-[19px] bg-accent" : "translate-x-[3px] bg-faint",
          ].join(" ")}
        />
      </button>
      {hideLabel ? null : (
        <span className="min-w-0">
          <span id={id} className="block text-[13px] text-ink">
            {label}
          </span>
          {hint ? <span className="block text-[11px] text-muted">{hint}</span> : null}
        </span>
      )}
    </div>
  );
}
