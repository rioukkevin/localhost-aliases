import type { ReactNode } from "react";

export interface PanelProps {
  /** Rack label — rendered uppercase, like the app's patchbay header. */
  title: string;
  /** Quiet text next to the title, e.g. a count. */
  meta?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** `false` when the body is full-bleed and pads its own rows. */
  padded?: boolean;
  className?: string;
  id?: string;
}

/** The one container shape: hairline border, rack-label strip on top, flat surfaces. */
export function Panel({
  title,
  meta,
  aside,
  children,
  footer,
  padded = true,
  className = "",
  id,
}: PanelProps) {
  return (
    <section id={id} className={`border border-hairline bg-canvas ${className}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-raised px-4 py-2.5 md:px-6">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">{title}</h2>
        {meta ? <span className="mono text-[11px] text-muted">{meta}</span> : null}
        {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
      </header>

      <div className={padded ? "px-4 py-5 md:px-6" : ""}>{children}</div>

      {footer ? <div className="border-t border-hairline px-4 py-3.5 md:px-6">{footer}</div> : null}
    </section>
  );
}
