"use client";

import { useState } from "react";
import type { AliasView, CreateAliasInput, ValidationIssue } from "@localhost-aliases/core/types";
import { validateAliasForm } from "../../lib/client/validate.ts";
import { FolderPicker } from "../projects/FolderPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { TextField } from "../ui/TextField.tsx";

export interface AliasEditorProps {
  /** Absent when creating. */
  alias?: AliasView;
  aliases: readonly AliasView[];
  tld: string;
  /** Pins the folder (the Projects view creates aliases inside one). */
  fixedProjectPath?: string | null;
  submitLabel: string;
  busy?: boolean;
  /** Field problems the server found. Cleared as soon as that field is edited. */
  serverIssues?: ValidationIssue[];
  onSubmit: (input: CreateAliasInput) => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * The one alias form: used to create and to edit, so the two can never disagree about
 * what a valid name is. Validation runs on every keystroke once a field has been
 * touched — the submit button is the last place you should learn a name is taken.
 */
export function AliasEditor({
  alias,
  aliases,
  tld,
  fixedProjectPath,
  submitLabel,
  busy = false,
  serverIssues,
  onSubmit,
  onCancel,
}: AliasEditorProps) {
  const [name, setName] = useState(alias?.name ?? "");
  const [port, setPort] = useState(alias ? String(alias.port) : "");
  const [projectPath, setProjectPath] = useState<string | null>(
    fixedProjectPath !== undefined ? fixedProjectPath : (alias?.projectPath ?? null),
  );
  const [touched, setTouched] = useState({ name: false, port: false });
  const [edited, setEdited] = useState<Record<string, boolean>>({});

  const issues = validateAliasForm({ name, port }, { aliases, tld, excludeId: alias?.id });
  const invalid = issues.name !== null || issues.port !== null;

  // A server issue outranks silence, but never survives the user fixing that field.
  const fromServer = (field: string) =>
    edited[field] ? null : (serverIssues?.find((i) => i.field === field)?.message ?? null);

  function submit() {
    setTouched({ name: true, port: true });
    if (invalid) return;
    void onSubmit({
      name: name.trim().toLowerCase(),
      port: Number(port.trim()),
      projectPath,
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <TextField
          label="Name"
          className="flex-1"
          placeholder="myapp"
          autoComplete="off"
          spellCheck={false}
          value={name}
          suffix={`.${tld}`}
          error={(touched.name ? issues.name : null) ?? fromServer("name")}
          hint="letters, digits and hyphens; dots make sub-names like api.myapp"
          onChange={(e) => {
            setEdited((d) => ({ ...d, name: true }));
            setName(e.currentTarget.value);
          }}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
        />
        <TextField
          label="Port"
          className="sm:w-[11rem]"
          placeholder="3000"
          inputMode="numeric"
          autoComplete="off"
          value={port}
          prefix=":"
          error={(touched.port ? issues.port : null) ?? fromServer("port")}
          warning={touched.port ? issues.portWarning : null}
          hint="the port your dev server already listens on"
          onChange={(e) => {
            setEdited((d) => ({ ...d, port: true }));
            setPort(e.currentTarget.value);
          }}
          onBlur={() => setTouched((t) => ({ ...t, port: true }))}
        />
      </div>

      {fixedProjectPath === undefined ? (
        <FolderPicker value={projectPath} onChange={setProjectPath} disabled={busy} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={busy} disabled={invalid}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <span className="mono text-[11px] text-faint">
          {name.trim() ? `http://${name.trim().toLowerCase()}.${tld}` : `http://name.${tld}`}
          {port.trim() ? ` → 127.0.0.1:${port.trim()}` : ""}
        </span>
      </div>
    </form>
  );
}
