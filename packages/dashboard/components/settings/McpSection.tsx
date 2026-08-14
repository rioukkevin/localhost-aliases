"use client";

import { useCallback, useEffect, useState } from "react";
import * as api from "../../lib/client/api.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Panel } from "../ui/Panel.tsx";
import { useToast } from "../ui/Toast.tsx";

/**
 * The MCP server's only home now that the nav is gone: one entry written into a
 * client's own config file, and nothing else. State is read once when the drawer
 * opens — this is a config file on disk, not something that changes under you, so
 * it has no business joining the 5s poll.
 */
export function McpSection() {
  const toast = useToast();
  const [state, setState] = useState<api.McpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.fetchMcp());
      setError(null);
    } catch (err) {
      setError(api.errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(client: api.McpClientState) {
    setBusy(client.id);
    try {
      setState(await api.installMcp(client.id));
      setError(null);
      toast.push({
        tone: "success",
        title: `mcp installed for ${client.name}`,
        detail: `One entry written to ${client.configPath}. Restart ${client.name} to pick it up.`,
      });
    } catch (err) {
      toast.push({ tone: "error", title: "Install failed", detail: api.errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  const clients = state?.clients ?? [];
  const codex = clients.find((c) => c.id === "codex");

  return (
    <Panel
      title="mcp"
      meta={state ? (state.configured ? "configured" : "not configured") : "…"}
      data-testid="mcp-section"
    >
      <p className="text-[13px] leading-relaxed text-muted">
        Adds a stdio MCP server so Claude Code and Codex can list and create aliases for you. It
        writes one entry into each client&apos;s config file and nothing else.
      </p>

      {error ? (
        <p className="mt-3 text-[12px] leading-relaxed text-danger" role="alert">
          Cannot read which clients are configured. {error}
        </p>
      ) : null}

      <ul className="mt-4 flex flex-col gap-3">
        {clients.map((client) => (
          <li key={client.id} className="flex flex-col gap-2 border-t border-hairline pt-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={client.configured ? "live" : "muted"} dot>
                {client.configured ? "configured" : "not configured"}
              </Chip>
              <span className="text-[12.5px] text-ink">{client.name}</span>
            </div>
            {client.configPath ? (
              <span className="mono break-all text-[11px] text-faint">{client.configPath}</span>
            ) : null}
            <div>
              <Button
                size="sm"
                busy={busy === client.id}
                disabled={busy !== null && busy !== client.id}
                onClick={() => void install(client)}
                data-testid={`mcp-install-${client.id}`}
              >
                {client.configured ? `Reinstall for ${client.name}` : `Install for ${client.name}`}
              </Button>
            </div>
          </li>
        ))}
        {clients.length === 0 && !error ? (
          <li className="text-[12px] text-faint">…</li>
        ) : null}
      </ul>

      {codex && state?.codexSnippet ? (
        <CodeBlock
          className="mt-4"
          label="paste this yourself if the file cannot be written"
          value={state.codexSnippet}
          what="snippet"
        />
      ) : null}
    </Panel>
  );
}
