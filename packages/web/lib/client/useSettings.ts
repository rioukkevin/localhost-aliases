"use client";

/**
 * Store for the Settings view.
 *
 * Deliberately NOT polled: this page holds a user-edited draft, and a background
 * refresh landing mid-edit would either fight the draft or silently discard it.
 * It reads once, and re-reads after a successful save.
 */
import { useCallback, useEffect, useState } from "react";
import type { AliasView, SystemStatus } from "@localhost-aliases/core";
import * as api from "./api.ts";
import { ApiError } from "./api.ts";

/** `/api/status` also returns the exact shell commands; not part of the frozen type. */
export type StatusWithCommands = SystemStatus & {
  commands?: { install?: string; start?: string; trust?: string };
};

export interface SettingsStore {
  saved: api.Settings | null;
  status: StatusWithCommands | null;
  aliases: AliasView[];
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  refresh: () => Promise<void>;
  /** Resolves to the server's warning (or null). Throws with a readable message. */
  save: (patch: Partial<api.Settings>) => Promise<string | null>;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return issues.length > 0 ? issues : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function useSettings(): SettingsStore {
  const [saved, setSaved] = useState<api.Settings | null>(null);
  const [status, setStatus] = useState<StatusWithCommands | null>(null);
  const [aliases, setAliases] = useState<AliasView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const settings = await api.fetchSettings();
      setSaved(settings);
      setLoadError(null);
    } catch (err) {
      setLoadError(describe(err));
    } finally {
      setLoading(false);
    }
    // Both are decoration around the settings themselves, so they degrade quietly.
    try {
      setStatus(await api.fetchStatus());
    } catch {
      setStatus(null);
    }
    try {
      setAliases(await api.fetchAliases());
    } catch {
      setAliases([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (patch: Partial<api.Settings>) => {
      setSaving(true);
      try {
        const result = await api.patchSettings(patch);
        setSaved(result.settings);
        void refresh();
        return result.warning ?? null;
      } catch (err) {
        throw new Error(describe(err));
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  return { saved, status, aliases, loading, loadError, saving, refresh, save };
}
