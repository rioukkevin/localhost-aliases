"use client";

import { useEffect, useState } from "react";
import * as api from "../../lib/client/api.ts";
import { useStatus, withRefresh } from "../../lib/client/status-store.ts";
import { validateDashboardPort, validateTld } from "../../lib/client/validate.ts";
import { LinkButton } from "../LinkButton.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Panel } from "../ui/Panel.tsx";
import { TextField } from "../ui/TextField.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { useToast } from "../ui/Toast.tsx";

export function SettingsView() {
  const { config, aliases, loaded } = useStatus();
  const toast = useToast();

  const [tld, setTld] = useState("");
  const [port, setPort] = useState("");
  const [https, setHttps] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

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
    <div className="flex flex-col gap-6">
      <Panel
        title="names"
        meta={loaded && config ? `${aliases.length} aliases use .${config.tld}` : "…"}
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              busy={saving}
              disabled={!changed || !!tldError || !!portError}
              onClick={() => void save()}
              data-testid="save-settings"
            >
              Save settings
            </Button>
            {changed ? (
              <span className="text-[11px] text-faint">
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <TextField
            label="TLD"
            className="sm:w-[16rem]"
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
            className="sm:w-[12rem]"
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

      <Panel title="setup">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          Setup is idempotent: re-running it re-checks every step against the real machine and
          fixes only what has drifted. Use it after a reboot, or if a name stops resolving.
        </p>
        <div className="mt-4">
          <LinkButton href="/onboarding" variant="outline">
            Re-run setup
          </LinkButton>
        </div>
      </Panel>

      <Panel title="uninstall">
        <Banner tone="danger" title="Remove everything this app changed">
          Stops the forwarder, removes the loopback addresses from lo0, strips the managed block
          from /etc/hosts, flushes DNS, deletes ~/.config/localhost-aliases and removes the local
          CA from your login keychain. One admin prompt, and nothing is left behind. Your
          projects and dev servers are not touched.
        </Banner>
        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
          All of that is privileged, so it does not run from this page — the dashboard is an
          unprivileged process and stays one. Use the menu-bar item, or run this in the repo:
        </p>
        <CodeBlock className="mt-3" value="make uninstall" what="command" label="uninstall" />
        <div className="mt-4">
          <Button variant="danger" onClick={() => setConfirmUninstall(true)} data-testid="uninstall">
            What will be removed?
          </Button>
        </div>
      </Panel>

      <ConfirmDialog
        open={confirmUninstall}
        size="md"
        title="What uninstalling removes"
        confirmLabel="Got it"
        cancelLabel="Close"
        onCancel={() => setConfirmUninstall(false)}
        onConfirm={() => setConfirmUninstall(false)}
      >
        <ul className="space-y-1">
          <li>— the managed /etc/hosts block is removed; the rest of the file is untouched</li>
          <li>— every 127.0.0.x loopback alias this app added is removed from lo0</li>
          <li>— the root forwarder is stopped</li>
          <li>— ~/.config/localhost-aliases is deleted, including your {aliases.length} aliases</li>
          <li>— the local CA is removed from your login keychain</li>
        </ul>
        <p className="mt-3">
          It asks for your password once, and it cannot be undone. Run it from the menu-bar app
          or with <span className="mono text-ink">make uninstall</span>.
        </p>
      </ConfirmDialog>
    </div>
  );
}
