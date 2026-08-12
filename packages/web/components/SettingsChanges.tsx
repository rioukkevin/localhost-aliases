"use client";

import { Button } from "./Button.tsx";
import type { SettingChange } from "../lib/client/settings-changes.ts";

const MAX_REWRITES = 6;

const TONE_BORDER: Record<SettingChange["tone"], string> = {
  warn: "border-down",
  info: "border-hairline-strong",
};

/**
 * One change, spelled out. The same component renders in the pending bar, in the
 * confirmation dialog and in the receipt afterwards, so the wording a user
 * agreed to is literally the wording they are shown was applied.
 */
export function ChangeList({ changes }: { changes: SettingChange[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {changes.map((change) => {
        const shown = change.rewrites?.slice(0, MAX_REWRITES) ?? [];
        const hidden = (change.rewrites?.length ?? 0) - shown.length;
        return (
          <li
            key={change.key}
            data-testid="settings-change"
            data-change={change.key}
            className={`border-l-2 pl-3.5 ${TONE_BORDER[change.tone]}`}
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
              {change.label}
            </p>
            <p className="mono mt-1 text-[13px] text-ink">
              <span className="text-muted line-through decoration-faint">{change.from}</span>
              <span className="px-2 text-faint">→</span>
              <span>{change.to}</span>
            </p>

            <ul className="mt-2 flex flex-col gap-1">
              {change.impact.map((line) => (
                <li key={line} className="flex gap-2 text-[12px] leading-relaxed text-muted">
                  <span aria-hidden="true" className="text-faint">
                    —
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            {shown.length > 0 ? (
              <div className="mt-2.5 border border-hairline bg-sunken px-3 py-2">
                <ul className="mono flex flex-col gap-0.5 text-[11.5px]">
                  {shown.map((rewrite) => (
                    <li key={rewrite.from} className="truncate">
                      <span className="text-muted line-through decoration-faint">
                        {rewrite.from}
                      </span>
                      <span className="px-2 text-faint">→</span>
                      <span className="text-ink">{rewrite.to}</span>
                    </li>
                  ))}
                  {hidden > 0 ? <li className="text-faint">and {hidden} more</li> : null}
                </ul>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface PendingChangesProps {
  changes: SettingChange[];
  saving: boolean;
  blocked: boolean;
  onApply: () => void;
  onDiscard: () => void;
}

/**
 * Sticks to the bottom of the viewport while there is an unapplied draft. It is
 * the answer to "what happens if I press the button" — nothing on this page is
 * written until it is used.
 */
export function PendingChanges({
  changes,
  saving,
  blocked,
  onApply,
  onDiscard,
}: PendingChangesProps) {
  return (
    <section
      data-testid="settings-pending"
      role="status"
      className="sticky bottom-0 z-20 border border-hairline bg-raised shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-2.5 md:px-6">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
          Not applied yet
        </h2>
        <span className="mono text-[11px] text-muted">
          {changes.length} {changes.length === 1 ? "change" : "changes"}
        </span>
      </header>

      <div className="max-h-[34vh] overflow-y-auto px-4 py-4 md:px-6">
        <ChangeList changes={changes} />
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3 md:px-6">
        <p className="mr-auto max-w-md text-[12px] leading-relaxed text-muted">
          Applying writes the config file, then pushes the new state to the privileged helper.
        </p>
        <Button size="md" variant="ghost" onClick={onDiscard} data-testid="settings-discard">
          Discard
        </Button>
        <Button
          size="md"
          variant="primary"
          busy={saving}
          disabled={blocked}
          onClick={onApply}
          data-testid="settings-apply"
        >
          Apply changes
        </Button>
      </footer>
    </section>
  );
}
