import type { ReactNode } from "react";
import { IconAlert } from "./Icons.tsx";

type Tone = "info" | "warn" | "danger";

const BAR: Record<Tone, string> = {
  info: "bg-accent",
  warn: "bg-down",
  danger: "bg-danger",
};

const MARK: Record<Tone, string> = {
  info: "text-accent",
  warn: "text-down",
  danger: "text-danger",
};

/** Full-width notice with a coloured edge. Flat, hairline, no card shadow. */
export function Banner({
  tone = "info",
  title,
  children,
  actions,
}: {
  tone?: Tone;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className="flex items-stretch border border-hairline bg-raised"
    >
      <span aria-hidden="true" className={`w-[3px] shrink-0 ${BAR[tone]}`} />
      <div className="min-w-0 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert className={MARK[tone]} />
          <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        </div>
        <div className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">{children}</div>
        {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
