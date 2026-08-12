"use client";

import { useState } from "react";
import type { AliasView, UpdateAliasInput } from "@localhost-aliases/core";
import { AliasDetachButton } from "./AliasDetachButton.tsx";
import { Button, IconButton } from "./Button.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { IconExternal, IconPencil, IconTrash } from "./Icons.tsx";
import { PatchCable } from "./PatchCable.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { TextField } from "./TextField.tsx";
import { UNASSIGNED_LABEL, type AliasGroup } from "../lib/client/grouping.ts";
import { nameError, normalizeName, portError, portWarning } from "../lib/client/validation.ts";

export interface AliasRowProps {
  alias: AliasView;
  aliases: AliasView[];
  tld: string;
  /** Folders an alias can be moved into, from the current grouping. */
  projects: AliasGroup[];
  onUpdate: (id: string, patch: UpdateAliasInput) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onSetProject: (id: string, projectPath: string | null) => Promise<boolean>;
}

const STATUS_NOTE: Record<AliasView["status"], string> = {
  up: "upstream is answering",
  down: "nothing is listening on this port",
  unknown: "not probed yet",
};

export function AliasRow({
  alias,
  aliases,
  tld,
  projects,
  onUpdate,
  onDelete,
  onSetProject,
}: AliasRowProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  // Optimistic rows carry a temporary id until the server answers.
  const pendingCreate = alias.id.startsWith("pending-");
  const label = alias.name;
  const suffix = alias.hostname.startsWith(`${alias.name}.`)
    ? alias.hostname.slice(alias.name.length)
    : `.${tld}`;

  async function handleDelete() {
    setSaving(true);
    await onDelete(alias.id);
    setSaving(false);
    setConfirming(false); // the toast reports failure; the dialog always closes
  }

  return (
    <li
      data-testid="alias-row"
      data-alias={alias.hostname}
      data-status={alias.status}
      data-project={alias.projectPath ?? ""}
      className="group relative flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 transition-colors hover:bg-raised md:px-8"
    >
      {editing ? (
        <AliasRowEditor
          alias={alias}
          aliases={aliases}
          projects={projects}
          suffix={suffix}
          busy={saving}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            setSaving(true);
            const ok = await onUpdate(alias.id, patch);
            setSaving(false);
            if (ok) setEditing(false);
          }}
        />
      ) : (
        <>
          {/* Order flips at sm: below it the cable wraps onto its own line with the
              port, so the hostname always gets the full width of the row. */}
          <span title={STATUS_NOTE[alias.status]} className="order-1 shrink-0">
            <StatusDot status={alias.status} />
          </span>

          <div className="order-2 min-w-0 flex-1 lg:w-[22rem] lg:flex-none">
            <p
              title={alias.hostname}
              className="mono truncate text-[17px] font-medium leading-tight text-ink md:text-[19px]"
            >
              {label}
              <span className="text-faint">{suffix}</span>
            </p>
            {/* The project is carried by the group header above, so this line is
                the URL the copy button yields — always present, never redundant. */}
            <p className="mono mt-1 truncate text-[11px] text-faint">
              {alias.url}
              {alias.description ? (
                <span className="text-muted"> · {alias.description}</span>
              ) : null}
            </p>
          </div>

          <div className="order-4 min-w-[3rem] flex-1 basis-full pl-[1.9rem] sm:order-3 sm:basis-0 sm:pl-0">
            <PatchCable status={alias.status} />
          </div>

          <p className="mono order-5 w-[4.5rem] shrink-0 text-right text-[15px] leading-tight text-ink sm:order-4 md:text-[17px]">
            <span className="text-faint">:</span>
            {alias.port}
          </p>

          <div className="order-3 ml-auto flex w-[11rem] shrink-0 items-center justify-end gap-0.5 sm:order-5 sm:ml-0">
            <CopyButton value={alias.url} what={`URL for ${alias.hostname}`} data-testid="copy" />
            <a
              href={alias.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${alias.url} in a new tab`}
              title="Open in browser"
              data-testid="alias-open"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[2px] border border-transparent text-muted transition-colors hover:border-hairline hover:text-ink"
            >
              <IconExternal />
            </a>
            <AliasDetachButton
              alias={alias}
              onDetach={(id) => onSetProject(id, null)}
            />
            <IconButton
              label={`Edit ${alias.hostname}`}
              data-testid="alias-edit"
              disabled={pendingCreate}
              onClick={() => setEditing(true)}
            >
              <IconPencil />
            </IconButton>
            <IconButton
              label={`Delete ${alias.hostname}`}
              data-testid="alias-delete"
              tone="danger"
              disabled={pendingCreate}
              onClick={() => setConfirming(true)}
            >
              <IconTrash />
            </IconButton>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={`Unpatch ${alias.hostname}?`}
        confirmLabel="Delete alias"
        busy={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={handleDelete}
      >
        The name stops resolving and the <span className="mono">/etc/hosts</span> entry is removed.
        Your dev server on port {alias.port} is not touched.
      </ConfirmDialog>
    </li>
  );
}

function AliasRowEditor({
  alias,
  aliases,
  projects,
  suffix,
  busy,
  onSave,
  onCancel,
}: {
  alias: AliasView;
  aliases: AliasView[];
  projects: AliasGroup[];
  suffix: string;
  busy: boolean;
  onSave: (patch: UpdateAliasInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(alias.name);
  const [port, setPort] = useState(String(alias.port));
  const [projectPath, setProjectPath] = useState(alias.projectPath ?? "");

  const nameIssue = nameError(name, aliases, alias.id) ?? (name.trim() === "" ? "Required." : null);
  const portIssue = portError(port) ?? (port.trim() === "" ? "Required." : null);
  const portNote = portWarning(port, aliases, alias.id);

  // The alias may sit in a folder that no longer holds any other alias, so its
  // own path is always offered even when the grouping does not list it.
  const options = [...projects.map((project) => project.path!)];
  if (alias.projectPath && !options.includes(alias.projectPath)) options.push(alias.projectPath);

  return (
    <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-start">
      <TextField
        label="Name"
        hideLabel
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        suffix={suffix}
        error={nameIssue}
        data-testid="alias-edit-name"
        className="lg:w-[18rem]"
      />
      <TextField
        label="Port"
        hideLabel
        value={port}
        onChange={(e) => setPort(e.target.value)}
        prefix=":"
        inputMode="numeric"
        error={portIssue}
        warning={portNote}
        data-testid="alias-edit-port"
        className="lg:w-[8rem]"
      />
      <div className="flex min-w-0 flex-col gap-1.5 lg:w-[14rem]">
        <label htmlFor={`${alias.id}-project`} className="sr-only">
          Project folder
        </label>
        <select
          id={`${alias.id}-project`}
          data-testid="alias-edit-project"
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          className="mono h-10 w-full min-w-0 truncate rounded-[2px] border border-hairline-strong bg-canvas px-2.5 text-[12px] text-ink"
        >
          <option value="">{UNASSIGNED_LABEL}</option>
          {options.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2 lg:ml-auto">
        <Button size="md" variant="ghost" onClick={onCancel} data-testid="alias-edit-cancel">
          Cancel
        </Button>
        <Button
          size="md"
          variant="primary"
          busy={busy}
          disabled={Boolean(nameIssue || portIssue)}
          data-testid="alias-edit-save"
          onClick={() =>
            onSave({
              name: normalizeName(name),
              port: Number(port.trim()),
              projectPath: projectPath === "" ? null : projectPath,
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}
