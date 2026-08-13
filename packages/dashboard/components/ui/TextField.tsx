"use client";

import { useId, type ComponentProps, type ReactNode } from "react";

// ComponentProps carries React 19 `ref` through `...rest`. `prefix` is omitted
// because React types it as the RDFa string attribute.
export interface TextFieldProps extends Omit<ComponentProps<"input">, "size" | "prefix"> {
  label: string;
  /** Quiet helper copy under the field. Hidden while an error is showing. */
  hint?: ReactNode;
  /** Blocking problem: turns the field red and sets aria-invalid. */
  error?: string | null;
  /** Non-blocking note, e.g. "another alias already uses this port". */
  warning?: string | null;
  /** Fixed text glued to the left of the input, e.g. ":" for a port. */
  prefix?: ReactNode;
  /** Fixed text glued to the right, e.g. ".local". */
  suffix?: ReactNode;
  /** Renders the label for screen readers only — used in dense inline forms. */
  hideLabel?: boolean;
  fieldClassName?: string;
}

export function TextField({
  label,
  hint,
  error,
  warning,
  prefix,
  suffix,
  hideLabel = false,
  className = "",
  fieldClassName = "",
  id,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-msg`;
  const message = error ?? warning ?? hint ?? null;

  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <label
        htmlFor={inputId}
        className={
          hideLabel
            ? "sr-only"
            : "text-[10px] font-medium uppercase tracking-[0.16em] text-faint"
        }
      >
        {label}
      </label>

      <div
        className={[
          "flex h-10 items-center gap-0 border bg-sunken px-0 transition-colors",
          // The ring wraps the field so it never paints over the suffix/prefix.
          "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
          error ? "border-danger" : "border-hairline-strong",
          fieldClassName,
        ].join(" ")}
      >
        {prefix ? (
          <span aria-hidden="true" className="mono pl-2.5 text-[15px] text-faint">
            {prefix}
          </span>
        ) : null}
        <input
          id={inputId}
          {...rest}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className="mono min-w-0 flex-1 bg-transparent px-2.5 text-[15px] text-ink placeholder:text-faint focus-visible:outline-none"
        />
        {suffix ? (
          <span aria-hidden="true" className="mono pr-2.5 text-[15px] text-faint">
            {suffix}
          </span>
        ) : null}
      </div>

      {message ? (
        <p
          id={messageId}
          role={error ? "alert" : undefined}
          className={[
            "text-[11px] leading-snug",
            error ? "text-danger" : warning ? "text-down" : "text-faint",
          ].join(" ")}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
