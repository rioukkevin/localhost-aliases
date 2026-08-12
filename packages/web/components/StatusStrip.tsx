"use client";

import { useSystemStatus } from "../lib/client/useSystemStatus.ts";

type Tone = "live" | "down" | "faint";

const DOT: Record<Tone, string> = {
  live: "bg-live",
  down: "bg-down",
  faint: "bg-faint",
};

function Reading({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <span className="flex items-baseline gap-2 whitespace-nowrap">
      <span className="text-[10px] uppercase tracking-[0.16em] text-faint">{label}</span>
      <span className="mono flex items-center gap-1.5 text-[12px] text-ink">
        {tone ? (
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[tone]} ${
              tone === "live" ? "dot-live" : ""
            }`}
          />
        ) : null}
        {value}
      </span>
    </span>
  );
}

/**
 * Global instrument readout. Lives in the shell so every view shows it, and
 * reads the shared status store rather than owning a poll of its own — one
 * `/api/status` request per tick for the whole document, refreshed the instant
 * any mutation succeeds.
 */
export function StatusStrip() {
  const { status, reachable } = useSystemStatus();

  const helper = status?.helper;
  const helperTone: Tone = helper?.running ? "live" : helper?.installed ? "down" : "faint";
  const helperValue = !reachable
    ? "unreachable"
    : !status
      ? "…"
      : helper?.running
        ? "running"
        : helper?.installed
          ? "stopped"
          : "not installed";

  const httpPort = helper?.status?.http.port;
  const httpsPort = helper?.status?.https.port;
  const scheme = status?.https ? "https" : "http";
  const schemeValue = status
    ? `${scheme}${status.https ? (httpsPort ? `:${httpsPort}` : "") : httpPort ? `:${httpPort}` : ""}`
    : "…";

  return (
    <div data-testid="status-strip" className="border-b border-hairline bg-raised">
      {/* Same max-width + padding as the page body, so the readings line up with it. */}
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-7 gap-y-2 px-4 py-2.5 md:px-8">
        <Reading label="helper" value={helperValue} tone={helperTone} />
        <Reading label="scheme" value={schemeValue} />
        <Reading label="tld" value={status ? `.${status.tld}` : "…"} />
        <Reading label="aliases" value={status ? String(status.aliasCount) : "…"} />
      </div>
    </div>
  );
}
