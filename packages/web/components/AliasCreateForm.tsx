"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core";
import { Button } from "./Button.tsx";
import { PatchCable } from "./PatchCable.tsx";
import { TextField } from "./TextField.tsx";
import { nameError, normalizeName, portError, portWarning } from "../lib/client/validation.ts";

export interface AliasCreateFormProps {
  aliases: AliasView[];
  tld: string;
  https: boolean;
  busy: boolean;
  onCreate: (input: CreateAliasInput) => Promise<boolean>;
}

export function AliasCreateForm({ aliases, tld, https, busy, onCreate }: AliasCreateFormProps) {
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  // Live, pre-submit: bad characters, reserved names and duplicates all resolve
  // here; "required" only appears once the user has actually tried to submit.
  const nameIssue = useMemo(
    () => nameError(name, aliases) ?? (submitted && name.trim() === "" ? "Give it a name." : null),
    [name, aliases, submitted],
  );
  const portIssue = useMemo(
    () => portError(port) ?? (submitted && port.trim() === "" ? "Pick a port." : null),
    [port, submitted],
  );
  const portNote = useMemo(() => portWarning(port, aliases), [port, aliases]);

  const preview = normalizeName(name) || "myapp";
  const previewUrl = `${https ? "https" : "http"}://${preview}.${tld}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);

    const cleanName = normalizeName(name);
    if (cleanName === "" || nameError(name, aliases) !== null) {
      nameRef.current?.focus();
      return;
    }
    if (port.trim() === "" || portError(port) !== null) {
      portRef.current?.focus();
      return;
    }

    const ok = await onCreate({ name: cleanName, port: Number(port.trim()) });
    if (ok) {
      setName("");
      setPort("");
      setSubmitted(false);
      nameRef.current?.focus();
    }
  }

  return (
    <form
      data-testid="alias-create-form"
      onSubmit={onSubmit}
      noValidate
      className="border border-hairline bg-raised"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5 md:px-6">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
          Patch a new alias
        </h2>
      </div>

      <div className="flex flex-col gap-4 px-4 py-5 md:flex-row md:items-start md:gap-4 md:px-6 lg:gap-5">
        <TextField
          ref={nameRef}
          label="Name"
          data-testid="alias-name-input"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="myapp"
          suffix={`.${tld}`}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          error={nameIssue}
          hint="Lowercase letters, digits and hyphens."
          className="md:flex-1 lg:w-[22rem] lg:flex-none"
        />

        {/* Decorative: the form itself is a patch in progress. */}
        <div className="hidden min-w-[3rem] flex-1 pt-7 lg:block" aria-hidden="true">
          <PatchCable status={nameIssue || portIssue ? "down" : "unknown"} />
        </div>

        <TextField
          ref={portRef}
          label="Port"
          data-testid="alias-port-input"
          name="port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="3000"
          prefix=":"
          inputMode="numeric"
          autoComplete="off"
          error={portIssue}
          warning={portNote}
          hint="Where your dev server listens."
          className="md:w-[9.5rem] md:shrink-0 lg:w-[11rem]"
        />

        <div className="flex shrink-0 flex-col gap-1.5 md:pt-[1.35rem]">
          <Button
            type="submit"
            variant="primary"
            data-testid="alias-submit"
            busy={busy}
            className="h-10 px-5"
          >
            Patch
          </Button>
        </div>
      </div>

      <p className="mono border-t border-hairline px-4 py-2.5 text-[11px] text-faint md:px-6">
        {previewUrl}
        <span className="px-2 text-faint">→</span>
        127.0.0.1:{port.trim() || "3000"}
      </p>
    </form>
  );
}
