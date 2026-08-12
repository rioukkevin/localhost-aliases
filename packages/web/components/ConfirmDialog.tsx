"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button.tsx";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  busy?: boolean;
  /** "md" for bodies that carry a list rather than a sentence. */
  size?: "sm" | "md";
  onConfirm: () => void;
  onCancel: () => void;
}

const WIDTH: Record<"sm" | "md", string> = {
  sm: "max-w-sm",
  md: "max-w-xl",
};

/**
 * Modal confirmation. Deliberately hand-rolled rather than <dialog>: we need it
 * to render identically under SSR, and the focus behaviour here is two buttons,
 * not a form.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  size = "sm",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      // Minimal focus trap: the panel only ever holds the two buttons.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreTo.current?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        onClick={onCancel}
        className="absolute inset-0 bg-canvas/80 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="confirm-dialog"
        className={`relative flex max-h-[80vh] w-full flex-col border border-hairline-strong bg-raised p-5 ${WIDTH[size]}`}
      >
        <h2 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h2>
        {children ? (
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto text-[12.5px] leading-relaxed text-muted">
            {children}
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} data-testid="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            size="sm"
            variant={tone === "danger" ? "danger" : "primary"}
            busy={busy}
            onClick={onConfirm}
            data-testid="confirm-accept"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
