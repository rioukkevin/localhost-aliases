import type { ReactNode } from "react";

export interface PanelProps {
  /** Rack label — rendered uppercase, like the patchbay header. */
  title: string;
  /** Quiet text next to the title, e.g. a count. */
  meta?: ReactNode;
  /** Pushed to the right of the header strip. */
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** `false` when the body is a full-bleed list that pads its own rows. */
  padded?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * The one container shape in the app: hairline border, a rack-label strip on
 * top, flat surfaces. Mirrors the header of AliasList / AliasCreateForm so a new
 * view cannot invent a second card style.
 */
export function Panel({
  title,
  meta,
  aside,
  children,
  footer,
  padded = true,
  className = "",
  ...rest
}: PanelProps) {
  return (
    <section
      data-testid={rest["data-testid"]}
      className={`border border-hairline bg-canvas ${className}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-raised px-4 py-2.5 md:px-6">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">{title}</h2>
        {meta ? <span className="mono text-[11px] text-muted">{meta}</span> : null}
        {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
      </header>

      <div className={padded ? "px-4 py-5 md:px-6" : ""}>{children}</div>

      {footer ? (
        <div className="border-t border-hairline px-4 py-3.5 md:px-6">{footer}</div>
      ) : null}
    </section>
  );
}
