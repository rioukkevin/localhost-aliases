"use client";

import { useEffect, useMemo, useState } from "react";
import { Banner } from "./Banner.tsx";
import { Button } from "./Button.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { HelperBanner } from "./HelperBanner.tsx";
import { ChangeList, PendingChanges } from "./SettingsChanges.tsx";
import { SettingsDashboard } from "./SettingsDashboard.tsx";
import { SettingsHostname } from "./SettingsHostname.tsx";
import { SettingsPorts } from "./SettingsPorts.tsx";
import { useToast } from "./Toast.tsx";
import {
  changesFor,
  draftErrors,
  draftFrom,
  patchFrom,
  type Draft,
  type SettingChange,
} from "../lib/client/settings-changes.ts";
import { useSettings } from "../lib/client/useSettings.ts";

interface Receipt {
  changes: SettingChange[];
  warning: string | null;
  at: string;
}

/**
 * Sole owner of the settings draft.
 *
 * The contract of this page: editing a field changes nothing on the machine. A
 * draft that differs from what is stored raises the pending bar, which spells
 * out every consequence; only "Apply changes" issues the PATCH. A TLD change
 * additionally asks for confirmation, because it renames every hostname at once.
 */
export function SettingsView({ startedByLaunchAgent }: { startedByLaunchAgent: boolean }) {
  const store = useSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  // Re-seed the draft whenever the stored settings change — on first load and
  // after a successful save, both of which mean "the draft is now the truth".
  const saved = store.saved;
  const savedKey = saved ? JSON.stringify(saved) : "";
  useEffect(() => {
    if (saved) setDraft(draftFrom(saved));
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = useMemo(() => (draft ? draftErrors(draft) : {}), [draft]);
  const changes = useMemo(
    () => (draft && saved ? changesFor(draft, saved, store.aliases) : []),
    [draft, saved, store.aliases],
  );
  const blocked = Object.keys(errors).length > 0;
  const renamesHostnames = changes.some((change) => change.key === "tld");

  function patch(next: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  async function apply() {
    if (!draft || !saved) return;
    const applying = changes;
    setConfirming(false);
    try {
      const warning = await store.save(patchFrom(draft, saved));
      setReceipt({ changes: applying, warning, at: new Date().toLocaleTimeString() });
      const what = applying.map((c) => `${c.label} ${c.from} → ${c.to}`).join(" · ");
      toast.push({
        tone: warning ? "info" : "success",
        title: warning
          ? "Saved, but not applied"
          : applying.length === 1
            ? "Setting applied"
            : `${applying.length} settings applied`,
        detail: warning ? `${what} — ${warning}` : what,
      });
    } catch (error) {
      toast.push({
        tone: "error",
        title: "Nothing was changed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {store.loadError ? (
        <Banner
          tone="danger"
          title="The dashboard API is not answering"
          actions={
            <Button size="sm" onClick={() => void store.refresh()}>
              Retry
            </Button>
          }
        >
          {store.loadError}
        </Banner>
      ) : (
        <HelperBanner status={store.status} />
      )}

      {receipt ? (
        <Banner
          data-testid="settings-receipt"
          tone={receipt.warning ? "warn" : "info"}
          title={receipt.warning ? `Saved at ${receipt.at}, but not applied` : `Applied at ${receipt.at}`}
        >
          <p className="mb-3">
            {receipt.warning ??
              "Written to the config file and pushed to the privileged helper, which rewrote the managed /etc/hosts block."}
          </p>
          <ChangeList changes={receipt.changes} />
        </Banner>
      ) : null}

      {draft && saved ? (
        <>
          <SettingsHostname
            value={draft.tld}
            savedTld={saved.tld}
            error={errors.tld}
            aliases={store.aliases}
            onChange={(tld) => patch({ tld })}
          />

          <SettingsPorts
            httpPort={draft.httpPort}
            httpsPort={draft.httpsPort}
            https={draft.https}
            errors={errors}
            status={store.status}
            onChange={patch}
          />

          <SettingsDashboard
            dashboardPort={saved.dashboardPort}
            startedByLaunchAgent={startedByLaunchAgent}
          />

          {changes.length > 0 ? (
            <PendingChanges
              changes={changes}
              saving={store.saving}
              blocked={blocked}
              onApply={() => (renamesHostnames ? setConfirming(true) : void apply())}
              onDiscard={() => setDraft(draftFrom(saved))}
            />
          ) : null}

          <ConfirmDialog
            open={confirming}
            tone="danger"
            size="md"
            title="Rename every hostname?"
            confirmLabel="Apply"
            busy={store.saving}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void apply()}
          >
            <ChangeList changes={changes} />
          </ConfirmDialog>
        </>
      ) : store.loading ? (
        <div className="border border-hairline bg-canvas px-4 py-10 md:px-6" aria-busy="true">
          <span className="block h-4 w-40 bg-sunken" />
        </div>
      ) : null}
    </div>
  );
}
