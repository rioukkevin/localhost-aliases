"use client";

import { useEffect, useState } from "react";
import { Chip } from "./Chip.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { Panel } from "./Panel.tsx";
import {
  AGENT_DISABLE_COMMAND,
  AGENT_STATUS_COMMAND,
  WEB_AGENT_LABEL,
} from "../lib/client/commands.ts";

export interface SettingsDashboardProps {
  /** The stored dashboard port. The live one is whatever this page was served on. */
  dashboardPort: number;
  /**
   * True when this process was started by launchd (its XPC_SERVICE_NAME matches
   * the agent label). It is the only evidence available without shelling out to
   * `launchctl`, which the dashboard deliberately never does.
   */
  startedByLaunchAgent: boolean;
}

/** Read-only facts about the dashboard process itself. */
export function SettingsDashboard({
  dashboardPort,
  startedByLaunchAgent,
}: SettingsDashboardProps) {
  // The stored port and the port actually being served can disagree — that gap
  // IS the explanation for why this field is read-only, so it is shown, not hidden.
  const [livePort, setLivePort] = useState<string | null>(null);
  useEffect(() => {
    setLivePort(window.location.port || (window.location.protocol === "https:" ? "443" : "80"));
  }, []);
  const drifted = livePort !== null && livePort !== String(dashboardPort);

  return (
    <Panel
      title="Dashboard"
      meta={drifted ? `stored :${dashboardPort} · serving :${livePort}` : `this page · :${dashboardPort}`}
    >
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-6">
        <div className="md:w-[11rem] md:shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Dashboard port
          </p>
          <div
            data-testid="settings-dashboard-port"
            className="mono mt-1.5 flex h-10 items-center border border-hairline bg-sunken px-3 text-[15px] text-muted"
          >
            <span className="text-faint">:</span>
            {dashboardPort}
          </div>
          <p className="mt-1.5 text-[11px] text-faint">Stored value · read-only.</p>
        </div>

        <div className="max-w-2xl flex-1 md:pt-[1.4rem]">
          <p className="text-[12px] leading-relaxed text-muted">
            A server cannot move the socket it is already answering on, so this only takes effect
            when the dashboard restarts — and if the new port were wrong you would have no page left
            to fix it from. Change it in <span className="mono text-ink">config.json</span> (or
            reinstall with <span className="mono text-ink">LA_DASHBOARD_PORT</span>) and restart, so
            the failure mode is a server that refuses to start rather than a dashboard you cannot
            reach.
          </p>
          {drifted ? (
            <p
              data-testid="settings-port-drift"
              className="mt-2 text-[12px] leading-relaxed text-down"
            >
              Right now they disagree: the stored value is{" "}
              <span className="mono">:{dashboardPort}</span>, but this page is being served on{" "}
              <span className="mono">:{livePort}</span> — exactly the restart-pending state
              described above.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-6 border-t border-hairline pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Launch at login
          </p>
          <Chip
            tone={startedByLaunchAgent ? "live" : "muted"}
            dot={startedByLaunchAgent}
            data-testid="settings-launch-agent"
          >
            {startedByLaunchAgent ? "running from the LaunchAgent" : "started manually"}
          </Chip>
        </div>

        <p className="mt-2.5 max-w-2xl text-[12px] leading-relaxed text-muted">
          {startedByLaunchAgent ? (
            <>
              launchd started this process as{" "}
              <span className="mono text-ink">{WEB_AGENT_LABEL}</span>, so the dashboard comes back
              on its own at every login and if it ever crashes.
            </>
          ) : (
            <>
              This process was started by hand, not by launchd. That says nothing about whether the
              agent <span className="mono text-ink">{WEB_AGENT_LABEL}</span> is installed —{" "}
              <span className="mono text-ink">scripts/install.sh</span> installs it, and the
              dashboard never runs <span className="mono text-ink">launchctl</span> itself to check.
            </>
          )}
        </p>

        <div className="mt-3 flex max-w-2xl flex-col gap-3">
          <CodeBlock
            value={AGENT_STATUS_COMMAND}
            what="status command"
            label="Check whether it is loaded"
          />
          <CodeBlock
            value={AGENT_DISABLE_COMMAND}
            what="disable command"
            label="Stop it starting at login"
          />
        </div>
      </div>
    </Panel>
  );
}
