import { CopyButton } from "./CopyButton.tsx";

/** Copyable literal text: shell commands, JSON snippets, file paths. */
export function CodeBlock({
  value,
  what = "snippet",
  label,
  className = "",
}: {
  value: string;
  what?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? (
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{label}</p>
      ) : null}
      <div className="flex items-stretch border border-hairline-strong bg-sunken">
        {/* pre-wrap, not pre: a silently clipped command is a broken command. */}
        <pre className="mono min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[12px] leading-relaxed text-ink">
          {value}
        </pre>
        <CopyButton value={value} what={what} className="m-1 self-start border-0 bg-transparent" />
      </div>
    </div>
  );
}
