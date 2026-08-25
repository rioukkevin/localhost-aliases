import type { ReactNode } from "react";
import { FigureMotion } from "./FigureMotion.tsx";

export interface FigureFrameProps {
  /** Rack label, rendered uppercase — the same strip the app's Panel uses. */
  label: string;
  /** Quiet machine-literal text beside the label. */
  meta?: ReactNode;
  /**
   * The figure in words. It is a real <figcaption>, not alt text: the diagram
   * above it is decorative markup, so this line is what a screen reader — or a
   * reader who simply does not decode diagrams — gets instead.
   */
  caption: ReactNode;
  children: ReactNode;
  className?: string;
}

/** The one shape every explanatory figure takes: hairline box, rack strip, caption. */
export function FigureFrame({ label, meta, caption, children, className = "" }: FigureFrameProps) {
  return (
    <figure className={`border border-hairline bg-canvas ${className}`}>
      <FigureMotion />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-raised px-4 py-2.5 md:px-6">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
          {label}
        </span>
        {meta ? <span className="mono text-[11px] text-muted">{meta}</span> : null}
      </div>

      <div className="px-4 py-5 md:px-6">{children}</div>

      <figcaption className="border-t border-hairline px-4 py-3 text-[12px] leading-relaxed text-muted md:px-6">
        {caption}
      </figcaption>
    </figure>
  );
}
