"use client";

import type { McpClientId, McpClientState } from "@localhost-aliases/core";
import { Button } from "./Button.tsx";
import { Chip } from "./Chip.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { abbreviateHome } from "../lib/client/paths.ts";
import type { McpInstallResult } from "../lib/client/api.ts";

export interface McpClientCardProps {
  id: McpClientId;
  name: string;
  /** One line on what this client is and where it keeps its config. */
  blurb: string;
  /** Config format, shown above the fallback snippet. */
  format: string;
  state: McpClientState;
  home: string;
  snippet: string;
  /** False when the server could not resolve the MCP entrypoint. */
  canInstall: boolean;
  installing: boolean;
  /** Set after a successful install in this session. */
  result: McpInstallResult | null;
  onInstall: (id: McpClientId) => void;
}

function stateChip(state: McpClientState) {
  if (state.installed) return { tone: "live" as const, text: "installed" };
  if (state.clientDetected) return { tone: "down" as const, text: "detected · not installed" };
  return { tone: "muted" as const, text: "client not detected" };
}

export function McpClientCard({
  id,
  name,
  blurb,
  format,
  state,
  home,
  snippet,
  canInstall,
  installing,
  result,
  onInstall,
}: McpClientCardProps) {
  const chip = stateChip(state);

  return (
    <section
      data-testid={`mcp-card-${id}`}
      data-installed={state.installed ? "yes" : "no"}
      className="flex flex-col border border-hairline bg-canvas"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-raised px-4 py-3 md:px-6">
        <h2 className="text-[14px] font-semibold tracking-tight text-ink">{name}</h2>
        <Chip tone={chip.tone} dot={chip.tone !== "muted"} data-testid={`mcp-state-${id}`}>
          {chip.text}
        </Chip>
      </header>

      <div className="flex flex-1 flex-col gap-4 px-4 py-5 md:px-6">
        <p className="text-[12.5px] leading-relaxed text-muted">{blurb}</p>

        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Config file
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className="mono min-w-0 flex-1 truncate text-[12px] text-ink"
              title={state.configPath}
            >
              {abbreviateHome(state.configPath, home)}
            </span>
            <CopyButton value={state.configPath} what={`${name} config path`} />
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
            {state.installed
              ? `This file already contains the localhost-aliases entry. Re-installing rewrites it and keeps a numbered backup.`
              : state.clientDetected
                ? `The file exists; installing adds one ${format} entry to it and backs the original up first.`
                : `The file does not exist yet. Installing creates it with a single ${format} entry — nothing else is touched.`}
          </p>
        </div>

        {result ? (
          <div
            data-testid={`mcp-result-${id}`}
            className="border-l-2 border-live pl-3.5"
            role="status"
          >
            <p className="text-[12.5px] font-medium text-ink">Installed</p>
            <p className="mono mt-1 break-all text-[11.5px] text-muted">
              wrote {abbreviateHome(result.configPath, home)}
            </p>
            <p className="mono mt-0.5 break-all text-[11.5px] text-muted">
              {result.backupPath
                ? `backup ${abbreviateHome(result.backupPath, home)}`
                : "no previous file — nothing to back up"}
            </p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
              Restart {name} so it picks the server up.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            variant={canInstall && !state.installed ? "primary" : "outline"}
            data-testid={`mcp-install-${id}`}
            busy={installing}
            disabled={!canInstall}
            title={canInstall ? undefined : "One-click install is unavailable in this build."}
            onClick={() => onInstall(id)}
          >
            {state.installed ? `Re-install for ${name}` : `Install for ${name}`}
          </Button>
          {!canInstall ? (
            <span className="text-[11.5px] text-down">Use the snippet below instead.</span>
          ) : null}
        </div>
      </div>

      <div className="border-t border-hairline px-4 py-4 md:px-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          Or paste this yourself ({format})
        </p>
        {snippet ? (
          <CodeBlock
            value={snippet}
            what={`${name} snippet`}
            className="mt-2"
            data-testid={`mcp-snippet-${id}`}
          />
        ) : (
          <p className="mt-2 text-[12px] text-down" data-testid={`mcp-snippet-${id}`}>
            The dashboard could not locate <span className="mono">packages/mcp/src/index.ts</span>,
            so it cannot show a snippet with a correct absolute path.
          </p>
        )}
      </div>
    </section>
  );
}
