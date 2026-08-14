"use client";

import { AliasDefaults } from "../settings/AliasDefaults.tsx";
import { AutoApplySection } from "../settings/AutoApply.tsx";
import { McpSection } from "../settings/McpSection.tsx";
import { UninstallSection } from "../settings/UninstallSection.tsx";
import { LinkButton } from "../LinkButton.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Panel } from "../ui/Panel.tsx";
import { StatusDetail } from "./StatusDetail.tsx";

/**
 * Everything global, in one column that comes in from the left: what the machine
 * is doing right now, whether a change applies itself, the defaults every alias
 * inherits, the MCP server, the way back into setup, and the way out.
 */
export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="left"
      title="Settings"
      subtitle="Global to this Mac. Nothing here touches your dev servers."
      data-testid="settings-drawer"
    >
      <div className="flex flex-col gap-6">
        <Panel title="connection">
          <StatusDetail />
        </Panel>

        <AutoApplySection />

        <AliasDefaults />

        <McpSection />

        <Panel title="setup">
          <p className="text-[13px] leading-relaxed text-muted">
            Setup is idempotent: re-running it re-checks every step against the real machine and
            fixes only what has drifted. Use it after a reboot, or if a name stops resolving.
          </p>
          <div className="mt-4">
            <LinkButton href="/onboarding" variant="outline" size="sm" data-testid="rerun-onboarding">
              Re-run onboarding
            </LinkButton>
          </div>
        </Panel>

        <UninstallSection />
      </div>
    </Drawer>
  );
}
