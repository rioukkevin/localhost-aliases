"use client";

import { useStatus } from "../../lib/client/status-store.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { autoApplyEnabled, readApply, readAutoApply } from "./auto-apply-read.ts";
import { CHIP_TONE, readInstall, readTray, type Reading } from "./status-read.ts";
import { useReapply } from "./useReapply.ts";

function Section({
  label,
  reading,
  testId,
}: {
  label: string;
  reading: Reading;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
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
 * The readings in full sentences, with the one action that changes them.
 * Shared by the floating indicator's panel and the settings drawer, so the two
 * surfaces can never tell the user different stories.
 *
 * The automatic-apply section is the only way back from a dismissed prompt: nothing
 * re-prompts on its own — a password dialog that reappears because you dismissed it is
 * malware behaviour — so "try again" has to be a button the user presses. While a prompt
 * is actually in flight that same button goes quiet rather than queueing a second one.
 */
export function StatusDetail() {
  const state = useStatus();
  const tray = readTray(state);
  const install = readInstall(state);
  const auto = readAutoApply(state);
  const apply = readApply(auto);
  const reapply = useReapply();

  const drift = state.sync?.drift ?? state.system?.drift ?? [];
  const command = state.sync?.intent.command ?? [];
  const applied = install.tone === "live";
  const enabled = autoApplyEnabled(state.config);
  const inFlight = auto.phase === "scheduled" || auto.phase === "prompting";

  return (
    <div className="flex flex-col gap-4" data-testid="status-detail">
      <Section label="menu-bar app" reading={tray} />
      <Section label="installation" reading={install} />
      {apply ? (
        <Section label="automatic apply" reading={apply} testId="status-autoapply" />
      ) : null}

      {!applied && drift.length > 0 ? (
        <ul className="mono space-y-0.5 text-[11px] text-faint">
          {drift.map((reason) => (
            <li key={reason}>— {reason}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={applied && !apply?.retryable ? "outline" : "primary"}
          size="sm"
          busy={reapply.busy}
          disabled={inFlight}
          onClick={reapply.run}
          data-testid="status-reapply"
          data-phase={auto.phase}
        >
          {apply?.retryable ? "Try again" : "Re-apply now"}
        </Button>
        <span className="text-[11px] text-faint">
          {inFlight
            ? "one prompt is already on its way"
            : applied
              ? "nothing has drifted"
              : "port changes need no prompt at all"}
        </span>
      </div>

      {!enabled ? (
        <p className="text-[11px] leading-relaxed text-faint" data-testid="autoapply-off-note">
          Automatic apply is off, so nothing asks for your password on its own. Changes are
          saved and wait here until you press the button above.
        </p>
      ) : null}

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
