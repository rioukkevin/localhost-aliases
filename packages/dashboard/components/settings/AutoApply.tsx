"use client";

import { useState } from "react";
import * as api from "../../lib/client/api.ts";
import { useStatus, withRefresh } from "../../lib/client/status-store.ts";
import { autoApplyEnabled } from "../shell/auto-apply-read.ts";
import { Panel } from "../ui/Panel.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { useToast } from "../ui/Toast.tsx";

/** The whole point of the switch, in one sentence each way. Pure, so it can be tested. */
export function autoApplyExplainer(enabled: boolean): string {
  return enabled
    ? "Three aliases added in a row still cost one password: the queued applies coalesce into a single prompt. Changing only a port never prompts at all — the forwarder watches its routes file and retargets itself."
    : "Nothing will ask for your password on its own. An alias you add is saved straight away, but its name does not resolve until you press Re-apply now in the banner or in the status panel.";
}

/**
 * One switch, saved the moment it moves — a lone toggle behind a Save button would be
 * two clicks to change one boolean.
 *
 * The copy is the spec's, verbatim, because it is the only place the user is told what
 * the password dialog is *for*. Turning it off says, in the same breath, what the app
 * does instead: nothing, until you press the button in the banner.
 */
export function AutoApplySection() {
  const { config, trayAlive } = useStatus();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // The switch answers the click; the poll reconciles it a moment later.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  const saved = autoApplyEnabled(config);
  const checked = optimistic ?? saved;

  async function change(next: boolean) {
    if (!config) return;
    setOptimistic(next);
    setSaving(true);
    try {
      const payload: api.SettingsInput & { autoApply?: boolean } = { autoApply: next };
      await withRefresh(() => api.updateSettings(payload));
      setOptimistic(null);
      toast.push({
        tone: "success",
        title: next ? "automatic apply on" : "automatic apply off",
        detail: next
          ? "Adding or removing an alias now raises the one admin prompt by itself."
          : "Changes are saved only. Apply them yourself from the banner or the status panel.",
      });
    } catch (err) {
      setOptimistic(null);
      toast.push({ tone: "error", title: "Change rejected", detail: api.errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="auto-apply" data-testid="autoapply-panel">
      <Toggle
        checked={checked}
        disabled={saving || !config}
        onChange={(next) => void change(next)}
        label="Apply changes automatically"
        hint="Adding or removing an alias asks for your password straight away. Turn this off if you would rather batch changes and apply them yourself."
        data-testid="autoapply-toggle"
      />

      <p className="mt-4 text-[12.5px] leading-relaxed text-muted" data-testid="autoapply-explainer">
        {autoApplyExplainer(checked)}
      </p>

      {checked && trayAlive === false ? (
        <p className="mt-3 text-[11px] leading-relaxed text-faint" data-testid="autoapply-no-tray">
          The menu-bar app is not running, so nothing can raise the prompt right now.
          Changes are still saved, and the banner explains what is waiting.
        </p>
      ) : null}
    </Panel>
  );
}
