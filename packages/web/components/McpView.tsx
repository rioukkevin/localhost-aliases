"use client";

import { useCallback, useEffect, useState } from "react";
import type { McpClientId } from "@localhost-aliases/core";
import { Banner } from "./Banner.tsx";
import { Button } from "./Button.tsx";
import { McpClientCard } from "./McpClientCard.tsx";
import { McpTransparency } from "./McpTransparency.tsx";
import { useToast } from "./Toast.tsx";
import * as api from "../lib/client/api.ts";
import { ApiError } from "../lib/client/api.ts";

export interface McpViewProps {
  home: string;
  dashboardPort: number;
  /**
   * Snippets resolved server-side from a path that was verified to exist. Used
   * only when the API could not produce its own — see app/mcp/fallback-spec.ts.
   */
  fallback: { entrypoint: string; claude: string; codex: string } | null;
}

const CLIENTS = [
  {
    id: "claude" as const,
    name: "Claude Code",
    format: "JSON",
    blurb:
      "Anthropic's terminal agent. Servers live under mcpServers in its config file; it reads them at startup.",
  },
  {
    id: "codex" as const,
    name: "Codex",
    format: "TOML",
    blurb:
      "OpenAI's terminal agent. Servers live in a [mcp_servers.*] table; everything else in the file is preserved.",
  },
];

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return issues.length > 0 ? issues : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Sole owner of the MCP state. Small enough not to need a separate store hook. */
export function McpView({ home, dashboardPort, fallback }: McpViewProps) {
  const toast = useToast();
  const [payload, setPayload] = useState<api.McpPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<McpClientId | null>(null);
  const [results, setResults] = useState<Partial<Record<McpClientId, api.McpInstallResult>>>({});

  const refresh = useCallback(async () => {
    try {
      setPayload(await api.fetchMcp());
      setLoadError(null);
    } catch (err) {
      setLoadError(describe(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function install(id: McpClientId) {
    setInstalling(id);
    try {
      const result = await api.installMcp(id);
      setResults((current) => ({ ...current, [id]: result }));
      // The install response already carries freshly re-detected client state, so
      // there is nothing to re-fetch — and a follow-up GET would race it.
      setPayload((current) => (current ? { ...current, clients: result.clients } : current));
      toast.push({
        tone: "success",
        title: `${id === "claude" ? "Claude Code" : "Codex"} configured`,
        detail: result.backupPath
          ? `Wrote ${result.configPath} · backup ${result.backupPath}`
          : `Wrote ${result.configPath} (no previous file to back up)`,
      });
    } catch (err) {
      toast.push({ tone: "error", title: "Install failed", detail: describe(err) });
    } finally {
      setInstalling(null);
    }
  }

  const specMissing = payload !== null && payload.spec === null;

  return (
    <div className="flex flex-col gap-5">
      {loadError ? (
        <Banner
          tone="danger"
          title="The dashboard API is not answering"
          actions={
            <Button size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Banner>
      ) : null}

      {specMissing ? (
        <Banner data-testid="mcp-spec-warning" tone="warn" title="One-click install is unavailable">
          {payload?.reason} Paste the snippet in the matching card instead — it is the same entry
          the button would have written.
          {fallback ? (
            <>
              {" "}
              The path in it was resolved from{" "}
              <span className="mono text-ink">{fallback.entrypoint}</span>, which exists on this
              machine.
            </>
          ) : null}
        </Banner>
      ) : null}

      {/* items-start: a JSON snippet is three times taller than the TOML one, and
          stretching both to the tallest leaves a dead void inside the short card. */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {CLIENTS.map((client) => {
          const state = payload?.clients[client.id] ?? {
            installed: false,
            clientDetected: false,
            configPath: "…",
          };
          const snippet = payload?.snippets[client.id] || fallback?.[client.id] || "";
          return (
            <McpClientCard
              key={client.id}
              id={client.id}
              name={client.name}
              blurb={client.blurb}
              format={client.format}
              state={state}
              home={home}
              snippet={snippet}
              canInstall={payload !== null && payload.spec !== null}
              installing={installing === client.id}
              result={results[client.id] ?? null}
              onInstall={(id) => void install(id)}
            />
          );
        })}
      </div>

      <McpTransparency dashboardPort={dashboardPort} />
    </div>
  );
}
