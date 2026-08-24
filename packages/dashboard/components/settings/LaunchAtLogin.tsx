"use client";

import { useCallback, useEffect, useState } from "react";
import * as api from "../../lib/client/api.ts";
import { Chip } from "../ui/Chip.tsx";
import { Panel } from "../ui/Panel.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { useToast } from "../ui/Toast.tsx";

/** How each `SMAppService` answer — and the one that means "we have not been told" — reads. */
export interface LaunchReading {
  /** The switch position. `null` means we will not put the switch anywhere. */
  checked: boolean | null;
  /** Chip text, always shown, so an unknown is visible rather than implied. */
  value: string;
  tone: "live" | "down" | "muted";
  note: string;
  /** False whenever moving the switch would be meaningless or misleading. */
  actionable: boolean;
}

/**
 * The whole mapping, pure, so every branch can be tested without a browser or a Mac.
 *
 * Two rules it exists to keep:
 *
 *  1. `unknown` must never render as a confident "off". The tray owns login-item.json; a
 *     build that has not shipped its half, a first launch that has not published yet, or a
 *     truncated file all arrive here as `unknown`, and every one of those means we have not
 *     asked the system — not that the user turned the feature off.
 *  2. `requiresApproval` must never render as "on". macOS accepted the registration but the
 *     app will NOT launch until the user allows it in System Settings. A switch that looks
 *     on while nothing happens at the next login is exactly how a feature looks broken.
 */
export function readLaunch(state: api.LaunchAtLoginState): LaunchReading {
  switch (state.status) {
    case "enabled":
      return {
        checked: true,
        value: "on",
        tone: "live",
        note: "Localhost Aliases opens when you log in. That means one administrator prompt per login: the root agent runs as root, cannot outlive a logout, and has to be started again each time.",
        actionable: true,
      };
    case "requiresApproval":
      return {
        checked: false,
        value: "needs approval",
        tone: "down",
        note: "macOS has the registration but it is switched off. Open System Settings › General › Login Items & Extensions, find Localhost Aliases under “Open at Login”, and turn it on. Until you do, the app will not start by itself — this switch cannot do it for you.",
        actionable: true,
      };
    case "notRegistered":
      return {
        checked: false,
        value: "off",
        tone: "muted",
        note: "Localhost Aliases does not start on its own. Between logging in and opening it your aliases do not resolve — nothing is installed to answer them while the app is closed.",
        actionable: true,
      };
    case "notFound":
      return {
        checked: false,
        value: "unavailable",
        tone: "muted",
        note: "macOS cannot find Localhost Aliases as a login item, so there is nothing to register. That is normal for a development build run outside an .app bundle, and for a bundle that has been moved since it was registered.",
        actionable: false,
      };
    default:
      return {
        checked: null,
        value: "unknown",
        tone: "muted",
        note: "The menu-bar app has not reported whether this is on. Only it can read the real setting, so rather than guess, this says nothing — it is not a claim that launching at login is off.",
        actionable: false,
      };
  }
}

/**
 * The launch-at-login switch.
 *
 * The dashboard cannot register a login item: `SMAppService` is AppKit, and this is a web
 * page. So the switch writes an ask and the menu-bar app answers by republishing the status
 * it read back from the system — never the value it was handed. Until it answers, the switch
 * shows `asking…` and stays where it was. See lib/launch-at-login.ts for the file contract
 * and apps/tray/Sources/LoginItem.swift for the other end of it.
 *
 * The help text says the cost out loud, before the click rather than after: with the root
 * agent model, launching at login means ONE ADMIN PROMPT PER LOGIN. A user who would hate
 * that deserves to know while the switch is still off.
 */
export function LaunchAtLoginSection() {
  const toast = useToast();
  const [state, setState] = useState<api.LaunchAtLoginState | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState(await api.fetchLaunchAtLogin());
    } catch {
      // A failed read is not knowledge either: unknown is already the honest default.
      setState(api.UNKNOWN_LAUNCH);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = state ?? api.UNKNOWN_LAUNCH;
  const reading = readLaunch(current);
  // A pending ask shows the move the user just made; the tray's answer replaces it.
  const checked =
    current.pending && current.requested !== null && current.requested !== "refresh"
      ? current.requested === "enable"
      : reading.checked;
  // `canToggle` is the tray's own verdict and outranks ours when it is present.
  const disabled = saving || current.pending || !reading.actionable || current.canToggle === false;

  async function change(next: boolean) {
    setSaving(true);
    try {
      setState(await api.setLaunchAtLogin(next ? "enable" : "disable"));
      toast.push({
        tone: "info",
        title: next ? "asked to launch at login" : "asked to stop launching at login",
        detail: next
          ? "The menu-bar app registers it and reports back. Remember: one admin prompt per login."
          : "The menu-bar app unregisters it and reports back.",
      });
    } catch (err) {
      toast.push({ tone: "error", title: "Change rejected", detail: api.errorMessage(err) });
      await reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="launch at login"
      data-testid="launch-panel"
      aside={
        <Chip tone={reading.tone} dot data-testid="launch-chip">
          {current.pending ? "asking…" : reading.value}
        </Chip>
      }
    >
      <Toggle
        checked={checked === true}
        disabled={disabled}
        onChange={(next) => void change(next)}
        label="Open Localhost Aliases when I log in"
        hint="One admin prompt per login. The root agent runs as root and cannot outlive a logout, so every login starts it again — and starting it is the prompt."
        data-testid="launch-toggle"
      />

      <p className="mt-4 text-[12.5px] leading-relaxed text-muted" data-testid="launch-note">
        {reading.note}
      </p>

      {current.needsSystemSettings && current.systemSettingsUrl ? (
        <p className="mt-3">
          <a
            href={current.systemSettingsUrl}
            className="text-[12.5px] text-accent underline-offset-2 hover:underline"
            data-testid="launch-settings-link"
          >
            Open Login Items in System Settings
          </a>
        </p>
      ) : null}

      {reading.checked === null ? (
        <p className="mt-3 text-[11px] leading-relaxed text-faint" data-testid="launch-unknown-note">
          The switch stays where it is until the menu-bar app reports a real state. An
          unanswered setting is shown as unknown, never as off.
        </p>
      ) : null}

      {current.updatedAt ? (
        <p className="mono mt-3 text-[10px] text-faint">read from the system {current.updatedAt}</p>
      ) : null}
    </Panel>
  );
}
