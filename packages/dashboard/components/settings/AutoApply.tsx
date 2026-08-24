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
    ? "At most one password per app launch, and only when the root agent is not already running: the prompt starts the agent, and from then on it watches your aliases and applies every change itself. Adding, renaming and deleting names never prompts while it runs."
    : "Nothing will ask for your password on its own. An alias you add is saved straight away, but its name does not resolve until you start the root agent yourself, from the banner or the status panel.";
}

/**
 * One switch, saved the moment it moves — a lone toggle behind a Save button would be
 * two clicks to change one boolean.
 *
 * This is the only place the user is told what the password dialog is *for*, so the copy
 * has to be exact: the prompt starts the ROOT AGENT, and it is the only prompt there is.
 * Once the agent is up it reconciles /etc/hosts, the lo0 addresses and its own routes from
 * the desired state, so an alias edit costs nothing. Turning the switch off says, in the
 * same breath, what the app does instead: nothing, until you press the button in the
 * banner yourself.
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
          ? "A change that needs the root agent now raises the one admin prompt by itself — once, to start it."
          : "Changes are saved only. Start the root agent yourself from the banner or the status panel.",
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
        label="Start the root agent automatically"
        hint="When a change needs the agent and it is not running, raise the one admin prompt straight away. Turn this off to be asked only when you press the button yourself."
        data-testid="autoapply-toggle"
      />

      <p className="mt-4 text-[12.5px] leading-relaxed text-muted" data-testid="autoapply-explainer">
        {autoApplyExplainer(checked)}
      </p>

      {checked && trayAlive === false ? (
        <p className="mt-3 text-[11px] leading-relaxed text-faint" data-testid="autoapply-no-tray">
          The menu-bar app is not running, so nothing can raise the one prompt right now, and
          a root agent already running would soon exit on its own — it watches the heartbeat
          the menu-bar app keeps. Changes are still saved, and the banner explains what is
          waiting.
        </p>
      ) : null}
    </Panel>
  );
}
