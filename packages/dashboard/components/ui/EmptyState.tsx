import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  /** Illustration slot — the aliases view puts a demo patch cable here. */
  figure?: ReactNode;
  actions?: ReactNode;
  "data-testid"?: string;
}

export function EmptyState({ title, children, figure, actions, ...rest }: EmptyStateProps) {
  return (
    <div
      data-testid={rest["data-testid"]}
      className="flex flex-col items-center gap-6 px-6 py-14 text-center"
    >
      {figure ? <div className="w-full max-w-lg">{figure}</div> : null}
      <div className="max-w-md">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {children ? (
          <div className="mt-2 text-[13px] leading-relaxed text-muted">{children}</div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
