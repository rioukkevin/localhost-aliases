"use client";

import { useStatus } from "../lib/client/status-store.ts";

type Lamp = "live" | "down" | "faint";

function Reading({ label, value, lamp }: { label: string; value: string; lamp?: Lamp }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[0.16em] text-faint">{label}</span>
      <span className="flex items-center gap-1.5">
        {lamp ? (
          <span
            aria-hidden="true"
            className={[
              "inline-block h-1.5 w-1.5 rounded-full",
              lamp === "live" ? "bg-live dot-live" : lamp === "down" ? "bg-down" : "bg-faint",
            ].join(" ")}
          />
        ) : null}
        <span className="mono text-[12px] text-ink">{value}</span>
      </span>
    </span>
  );
}

/**
 * The global instrument readout: is the forwarder up, does live state match what the
 * config asks for, which TLD, how many aliases. Same content column as the pages, so
 * the readings line up with the view below them.
 */
export function StatusStrip() {
  const { loaded, reachable, config, system, sync, aliases } = useStatus();

  const forwarder = !loaded
    ? { value: "…", lamp: "faint" as Lamp }
    : !reachable
      ? { value: "unreachable", lamp: "down" as Lamp }
      : system?.forwarder
        ? { value: "running", lamp: "live" as Lamp }
        : { value: "stopped", lamp: "down" as Lamp };

  const drift = sync?.drift ?? system?.drift ?? [];
  const applied = !loaded
    ? { value: "…", lamp: "faint" as Lamp }
    : (sync?.applied ?? system?.applied)
      ? { value: "applied", lamp: "live" as Lamp }
      : { value: `drift:${drift.length || 1}`, lamp: "down" as Lamp };

  const scheme = config ? `${config.https ? "https" : "http"}:${config.dashboardPort}` : "…";

  return (
    <div className="border-b border-hairline bg-raised" data-testid="status-strip">
      <div className="mx-auto w-full max-w-5xl px-4 md:px-8">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2 py-2.5">
          <Reading label="forwarder" value={forwarder.value} lamp={forwarder.lamp} />
          <Reading label="state" value={applied.value} lamp={applied.lamp} />
          <Reading label="dashboard" value={scheme} />
          <Reading label="tld" value={config ? `.${config.tld}` : "…"} />
          <Reading label="aliases" value={loaded ? String(aliases.length) : "…"} />
        </div>
      </div>
    </div>
  );
}
