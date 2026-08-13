import type { ReactNode } from "react";
import { IconAlert } from "./Icons.tsx";

export type BannerTone = "info" | "warn" | "danger";

const TONE: Record<BannerTone, { bar: string; icon: string }> = {
  info: { bar: "bg-accent", icon: "text-accent" },
  warn: { bar: "bg-down", icon: "text-down" },
  danger: { bar: "bg-danger", icon: "text-danger" },
};

export interface BannerProps {
  tone?: BannerTone;
  title: string;
  children?: ReactNode;
  /** Buttons / copy affordances rendered under the body. */
  actions?: ReactNode;
  "data-testid"?: string;
}

/** Full-width notice with a coloured edge. Flat, hairline, no card shadow. */
export function Banner({ tone = "info", title, children, actions, ...rest }: BannerProps) {
  const t = TONE[tone];
  return (
    <section
      data-testid={rest["data-testid"]}
      role={tone === "danger" ? "alert" : "status"}
      className="flex items-stretch border border-hairline bg-raised"
    >
      <span aria-hidden="true" className={`w-[3px] shrink-0 ${t.bar}`} />
      <div className="min-w-0 flex-1 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert className={t.icon} />
          <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
        </div>
        {children ? (
          <div className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">{children}</div>
        ) : null}
        {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}
