"use client";

import type { SystemStatus } from "@localhost-aliases/core";
import { Banner } from "./Banner.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { HELPER_INSTALL_COMMAND, HELPER_START_COMMAND } from "../lib/client/commands.ts";

/**
 * `/api/status` also returns the exact shell commands. They are optional here so
 * the banner still renders against an older/partial payload.
 */
type StatusWithCommands = SystemStatus & {
  commands?: { install?: string; start?: string };
};

/**
 * The helper is what actually owns :80 and /etc/hosts. Without it an alias is
 * only a config entry, so this is the loudest thing on the page when it is gone.
 */
export function HelperBanner({ status }: { status: SystemStatus | null }) {
  if (!status) return null;
  const helper = status.helper;
  if (helper?.running) return null;

  const commands = (status as StatusWithCommands).commands;
  const installed = Boolean(helper?.installed);
  const command = installed
    ? (commands?.start ?? HELPER_START_COMMAND)
    : (commands?.install ?? HELPER_INSTALL_COMMAND);

  return (
    <Banner
      data-testid="helper-banner"
      tone="warn"
      title={
        installed
          ? "The privileged helper is not running"
          : "The privileged helper is not installed"
      }
      actions={
        <div className="flex w-full max-w-2xl items-stretch border border-hairline-strong bg-sunken">
          <code className="mono min-w-0 flex-1 overflow-x-auto whitespace-pre px-3 py-2.5 text-[12px] text-ink">
            {command}
          </code>
          <CopyButton
            value={command}
            what="command"
            withLabel
            className="m-1 shrink-0 border-0 bg-transparent"
          />
        </div>
      }
    >
      Aliases are still saved, but nothing writes <span className="mono">/etc/hosts</span> or
      answers on <span className="mono">:80</span> until the helper is
      {installed ? " running" : " installed"}. Run this from the repository root:
    </Banner>
  );
}
