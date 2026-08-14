"use client";

import { useEffect, useState } from "react";
import * as api from "../../lib/client/api.ts";
import { useStatus, withRefresh } from "../../lib/client/status-store.ts";
import { validateDashboardPort, validateTld } from "../../lib/client/validate.ts";
import { Button } from "../ui/Button.tsx";
import { Panel } from "../ui/Panel.tsx";
import { TextField } from "../ui/TextField.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { useToast } from "../ui/Toast.tsx";

/**
 * The few things that are global: the TLD every name ends in, where the dashboard
 * itself listens, and whether it does so over https. Unchanged logic from the old
 * settings page — only the column it sits in got narrower.
 */
export function AliasDefaults() {
  const { config, aliases, loaded } = useStatus();
  const toast = useToast();

  const [tld, setTld] = useState("");
  const [port, setPort] = useState("");
  const [https, setHttps] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // The config arrives from the poll; adopt it until the user starts editing.
  useEffect(() => {
    if (!config || dirty) return;
    setTld(config.tld);
    setPort(String(config.dashboardPort));
    setHttps(config.https);
  }, [config, dirty]);

  const tldError = validateTld(tld);
  const portError = validateDashboardPort(port);
  const changed =
    !!config &&
    (tld !== config.tld || Number(port) !== config.dashboardPort || https !== config.https);
  const tldChanged = !!config && tld !== config.tld;

  async function save() {
    if (tldError || portError || !config) return;
    setSaving(true);
    try {
      const result = await withRefresh(() =>
        api.updateSettings({ tld, dashboardPort: Number(port), https }),
      );
      setDirty(false);
      const notes = [
        tldChanged ? "Re-apply to move every hostname over to the new TLD." : null,
        result.restartRequired ? "The new dashboard port takes effect when the app restarts." : null,
      ].filter(Boolean);
      toast.push({
        tone: "success",
        title: "settings saved",
        ...(notes.length > 0 ? { detail: notes.join(" ") } : {}),
      });
    } catch (err) {
      toast.push({ tone: "error", title: "Change rejected", detail: api.errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="names"
      meta={loaded && config ? `${aliases.length} aliases use .${config.tld}` : "…"}
      footer={
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            size="sm"
            busy={saving}
            disabled={!changed || !!tldError || !!portError}
            onClick={() => void save()}
            data-testid="save-settings"
          >
            Save settings
          </Button>
          {changed ? (
            <span className="text-[11px] leading-snug text-faint">
              {tldChanged
                ? "Changing the TLD renames every hostname — the next apply needs one admin prompt."
                : "The dashboard port change takes effect when the app restarts the server."}
            </span>
          ) : (
            <span className="text-[11px] text-faint">nothing to save</span>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="TLD"
          prefix="."
          value={tld}
          error={tldError}
          hint="appended to every alias name, e.g. myapp.local"
          onChange={(e) => {
            setDirty(true);
            setTld(e.currentTarget.value);
          }}
        />
        <TextField
          label="Dashboard port"
          prefix=":"
          inputMode="numeric"
          value={port}
          error={portError}
          hint="the port this dashboard binds on 127.0.0.1"
          onChange={(e) => {
            setDirty(true);
            setPort(e.currentTarget.value);
          }}
        />
      </div>

      <div className="mt-5 border-t border-hairline pt-5">
        <Toggle
          checked={https}
          onChange={(next) => {
            setDirty(true);
            setHttps(next);
          }}
          label="Serve the dashboard over https"
          hint="Dashboard only. Project aliases are raw TCP forwards, so they can never be https."
          data-testid="https-toggle"
        />
      </div>
    </Panel>
  );
}
