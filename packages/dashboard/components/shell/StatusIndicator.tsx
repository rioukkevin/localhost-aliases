"use client";

import { useEffect, useRef, useState } from "react";
import { useStatus } from "../../lib/client/status-store.ts";
import { StatusDetail } from "./StatusDetail.tsx";
import { readApply, readAutoApply } from "./auto-apply-read.ts";
import { LAMP, readAgent, readInstall, readTray, type Reading } from "./status-read.ts";

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
 * Three permanent readings, never conflated: whether the menu-bar app is answering,
 * whether the ROOT AGENT is running, and whether this Mac actually matches your aliases.
 * All three say "checking…" until the first poll has come back — the previous shell
 * asserted "the menu-bar app is not running" on every page load, which was a claim about
 * the machine made before asking it.
 *
 * The agent lamp earns its permanent place because it is the one thing that decides
 * whether editing an alias costs a password. Running: nothing ever prompts. Not running:
 * one prompt, offered by the button in the panel below.
 *
 * A fourth appears only while an apply is in flight or stuck, because a permanent
 * "auto-apply: idle" lamp would be three words of chrome saying nothing happened. Its
 * detail panel carries the one button that gets a dismissed prompt back.
 */
export function StatusIndicator() {
  const state = useStatus();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const tray = readTray(state);
  const agent = readAgent(state);
  const install = readInstall(state);
  const apply = readApply(readAutoApply(state));

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
        aria-label={[
          `Menu-bar app ${tray.value}`,
          `root agent ${agent.value}`,
          `installation ${install.value}`,
          apply ? `automatic apply ${apply.value}` : null,
        ]
          .filter(Boolean)
          .join(", ")}
        onClick={() => setOpen((was) => !was)}
        className={[
          "flex h-8 select-none items-center gap-2.5 rounded-[2px] border px-2.5",
          "transition-colors duration-150",
          open ? "border-hairline-strong bg-sunken" : "border-hairline-strong bg-raised hover:bg-sunken",
        ].join(" ")}
      >
        <Gauge label="tray" reading={tray} />
        <span aria-hidden="true" className="h-3 w-px bg-hairline-strong" />
        <span data-testid="agent-gauge" data-running={agent.tone === "live"}>
          <Gauge label="agent" reading={agent} />
        </span>
        <span aria-hidden="true" className="h-3 w-px bg-hairline-strong" />
        <Gauge label="state" reading={install} />
        {apply ? (
          <>
            <span aria-hidden="true" className="h-3 w-px bg-hairline-strong" />
            <span data-testid="apply-gauge" data-phase={apply.phase}>
              <Gauge label="apply" reading={apply} />
            </span>
          </>
        ) : null}
      </button>
    </div>
  );
}
