"use client";

import { useEffect, useRef, useState } from "react";
import { useStatus } from "../../lib/client/status-store.ts";
import { StatusDetail } from "./StatusDetail.tsx";
import { LAMP, readInstall, readTray, type Reading } from "./status-read.ts";

function Lamp({ reading }: { reading: Reading }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${LAMP[reading.tone]}`}
    />
  );
}

function Gauge({ label, reading }: { label: string; reading: Reading }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="hidden text-[10px] font-medium uppercase tracking-[0.16em] text-faint sm:inline">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <Lamp reading={reading} />
        <span className="mono text-[11px] text-ink">{reading.value}</span>
      </span>
    </span>
  );
}

/**
 * The instrument lamp, bottom right, on every view.
 *
 * Two readings, never conflated: whether the menu-bar app is answering, and whether
 * this Mac actually matches your aliases. Both say "checking…" until the first poll
 * has come back — the previous shell asserted "the menu-bar app is not running" on
 * every page load, which was a claim about the machine made before asking it.
 */
export function StatusIndicator() {
  const state = useStatus();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const tray = readTray(state);
  const install = readInstall(state);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="fixed bottom-4 right-4 z-30 flex flex-col items-end md:bottom-6 md:right-6"
    >
      {open ? (
        <div
          role="dialog"
          aria-label="Connection and installation status"
          data-testid="status-panel"
          className="mb-2 w-[min(22rem,calc(100vw-2rem))] border border-hairline-strong bg-raised px-4 py-4"
        >
          <StatusDetail />
        </div>
      ) : null}

      <button
        ref={buttonRef}
        type="button"
        data-testid="status-indicator"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Menu-bar app ${tray.value}, installation ${install.value}`}
        onClick={() => setOpen((was) => !was)}
        className={[
          "flex h-8 select-none items-center gap-2.5 rounded-[2px] border px-2.5",
          "transition-colors duration-150",
          open ? "border-hairline-strong bg-sunken" : "border-hairline-strong bg-raised hover:bg-sunken",
        ].join(" ")}
      >
        <Gauge label="tray" reading={tray} />
        <span aria-hidden="true" className="h-3 w-px bg-hairline-strong" />
        <Gauge label="state" reading={install} />
      </button>
    </div>
  );
}
