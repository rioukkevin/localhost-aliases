"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import { IconClose } from "./Icons.tsx";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side: "left" | "right";
  title: string;
  /** Optional short line under the title. */
  subtitle?: string;
  /** Rendered in the drawer's header, right-aligned (actions, chips). */
  headerAccessory?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The one off-canvas surface in the app: settings come in from the left, a
 * project's aliases from the right. Same panel, same rules — hairline edge, flat
 * surfaces, square corners.
 *
 * It renders nothing at all while closed, so the whole modal contract (focus
 * capture, scroll lock, Escape) lives in a child that only exists while open:
 * mounting *is* opening, and the effect cleanup *is* the restore.
 */
export function Drawer(props: DrawerProps) {
  if (!props.open) return null;
  return <DrawerPanel {...props} />;
}

function DrawerPanel({
  onClose,
  side,
  title,
  subtitle,
  headerAccessory,
  children,
  ...rest
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Consumers pass an inline arrow, so its identity changes on every parent render —
  // and the parent re-renders every poll. Keeping it in a ref is what lets the effect
  // below run exactly once per opening: re-running it would re-focus the panel every
  // five seconds, stealing the caret out of whatever field you were typing in.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;
    // Focus the panel itself rather than its first control: the dialog is
    // announced with its title before anything inside it can steal the reading.
    panel?.focus();

    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;

      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        // Nothing to move to: keep the focus on the panel rather than let it
        // wander back to the page underneath.
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = bodyOverflow;
      restoreTo?.focus?.();
    };
  }, []);

  return (
    <div className={`fixed inset-0 z-40 flex ${side === "right" ? "justify-end" : "justify-start"}`}>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="scrim-in absolute inset-0 bg-canvas/80 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={rest["data-testid"] ?? "drawer"}
        data-side={side}
        className={[
          "relative flex h-full w-full max-w-xl flex-col bg-canvas outline-none",
          side === "right"
            ? "border-l border-hairline-strong drawer-in-right"
            : "border-r border-hairline-strong drawer-in-left",
        ].join(" ")}
      >
        <header className="flex items-start gap-3 border-b border-hairline bg-raised px-4 py-3 md:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[14px] font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 text-[12px] leading-snug text-muted">{subtitle}</p>
            ) : null}
          </div>
          {headerAccessory ? (
            <div className="flex shrink-0 items-center gap-2">{headerAccessory}</div>
          ) : null}
          <IconButton label="Close" onClick={onClose} data-testid="drawer-close">
            <IconClose />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-5">{children}</div>
      </div>
    </div>
  );
}
