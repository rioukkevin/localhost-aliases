"use client";

import { useStatus } from "../../lib/client/status-store.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { CHIP_TONE, readInstall, readTray, type Reading } from "./status-read.ts";
import { useReapply } from "./useReapply.ts";

function Section({ label, reading }: { label: string; reading: Reading }) {
  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={CHIP_TONE[reading.tone]} dot>
          {reading.value}
        </Chip>
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          {label}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{reading.note}</p>
    </section>
  );
}

/**
 * The two readings in full sentences, with the one action that changes them.
 * Shared by the floating indicator's panel and the settings drawer, so the two
 * surfaces can never tell the user different stories.
 */
export function StatusDetail() {
  const state = useStatus();
  const tray = readTray(state);
  const install = readInstall(state);
  const reapply = useReapply();

  const drift = state.sync?.drift ?? state.system?.drift ?? [];
  const command = state.sync?.intent.command ?? [];
  const applied = install.tone === "live";

  return (
    <div className="flex flex-col gap-4" data-testid="status-detail">
      <Section label="menu-bar app" reading={tray} />
      <Section label="installation" reading={install} />

      {!applied && drift.length > 0 ? (
        <ul className="mono space-y-0.5 text-[11px] text-faint">
          {drift.map((reason) => (
            <li key={reason}>— {reason}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={applied ? "outline" : "primary"}
          size="sm"
          busy={reapply.busy}
          onClick={reapply.run}
          data-testid="status-reapply"
        >
          Re-apply now
        </Button>
        <span className="text-[11px] text-faint">
          {applied ? "nothing has drifted" : "port changes need no prompt at all"}
        </span>
      </div>

      {!applied && state.sync?.needsPrompt && command.length > 0 ? (
        <CodeBlock
          label="the dashboard cannot run this — the menu-bar app does, behind one prompt"
          value={command.join(" ")}
          what="command"
        />
      ) : null}
    </div>
  );
}
