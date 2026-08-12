"use client";

import { useState, type FormEvent } from "react";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core";
import { AliasMini } from "./AliasMini.tsx";
import { Button } from "./Button.tsx";
import { Chip } from "./Chip.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { IconPlus } from "./Icons.tsx";
import { TextField } from "./TextField.tsx";
import { useAliasDraft } from "../lib/client/alias-draft.ts";
import type { AliasGroup } from "../lib/client/grouping.ts";
import { abbreviateHome, joinPath, WORKSPACE_FILENAME } from "../lib/client/paths.ts";

export interface ProjectCardProps {
  /** A grouped folder — `group.path` is never null here. */
  group: AliasGroup;
  /** Every alias, so the inline form can predict name and port collisions. */
  aliases: AliasView[];
  /** $HOME, handed down from the server component, so paths can show as ~/… */
  home: string;
  tld: string;
  /** True while this project's workspace file is being written. */
  busy: boolean;
  onAddAlias: (input: CreateAliasInput) => Promise<boolean>;
  onDetach: (id: string) => Promise<boolean>;
  /** Writes (or refreshes) .localhost-aliases.json from the aliases below. */
  onWriteWorkspace: (path: string) => void;
}

export function ProjectCard({
  group,
  aliases,
  home,
  tld,
  busy,
  onAddAlias,
  onDetach,
  onWriteWorkspace,
}: ProjectCardProps) {
  const path = group.path!;
  const [adding, setAdding] = useState(false);
  const filePath = joinPath(path, WORKSPACE_FILENAME);

  return (
    <section
      data-testid="project-card"
      data-project={path}
      data-workspace={group.hasWorkspaceFile ? "present" : "absent"}
      className="border border-hairline bg-canvas"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline bg-raised px-4 py-3 md:px-6">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold tracking-tight text-ink">
            {group.name}
          </h2>
          <p className="mono mt-0.5 truncate text-[11px] text-muted" title={path}>
            {abbreviateHome(path, home)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Muted on purpose: the per-row lamps already carry the liveness, and
              two coloured chips side by side fight for the same attention. */}
          <Chip tone="muted">
            {group.aliases.length} {group.aliases.length === 1 ? "alias" : "aliases"}
            {group.live > 0 ? ` · ${group.live} live` : ""}
          </Chip>
          <Chip tone={group.hasWorkspaceFile ? "accent" : "muted"}>
            {group.hasWorkspaceFile ? "workspace file" : "no workspace file"}
          </Chip>
          <CopyButton value={path} what={`path of ${group.name}`} />
        </div>
      </header>

      <ul className="divide-y divide-hairline">
        {group.aliases.map((alias) => (
          <AliasMini key={alias.id} alias={alias} onDetach={onDetach} />
        ))}
      </ul>

      {adding ? (
        <AddAliasForm
          aliases={aliases}
          tld={tld}
          path={path}
          onCancel={() => setAdding(false)}
          onAdd={onAddAlias}
        />
      ) : (
        <div className="border-t border-hairline px-4 py-2.5 md:px-6">
          <Button
            size="sm"
            variant="ghost"
            data-testid="project-add-alias"
            onClick={() => setAdding(true)}
          >
            <IconPlus />
            Add an alias to this project
          </Button>
        </div>
      )}

      <footer className="flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-hairline px-4 py-3.5 md:px-6">
        <div className="min-w-0 flex-1">
          <p className="mono truncate text-[11px] text-ink" title={filePath}>
            {abbreviateHome(filePath, home)}
          </p>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-muted">
            {group.hasWorkspaceFile ? (
              <>
                A committed record of the names this repo expects. Nothing reads it at runtime —
                rewrite it when these ports change so a teammate can re-create the same aliases.
              </>
            ) : (
              <>
                Optional. Writing it drops a small JSON file in the folder listing these names and
                ports, so the next person (or agent) can re-create them. Your aliases work exactly
                the same without it.
              </>
            )}
          </p>
        </div>

        <Button
          size="sm"
          variant={group.hasWorkspaceFile ? "outline" : "primary"}
          busy={busy}
          data-testid="project-write-workspace"
          onClick={() => onWriteWorkspace(path)}
        >
          {group.hasWorkspaceFile ? "Rewrite workspace file" : "Write workspace file"}
        </Button>
      </footer>
    </section>
  );
}

/** The folder is already decided, so this is only ever a name and a port. */
function AddAliasForm({
  aliases,
  tld,
  path,
  onAdd,
  onCancel,
}: {
  aliases: AliasView[];
  tld: string;
  path: string;
  onAdd: (input: CreateAliasInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const draft = useAliasDraft(aliases);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = draft.validate();
    if (!values) return;
    setBusy(true);
    const ok = await onAdd({ ...values, projectPath: path });
    setBusy(false);
    if (ok) {
      draft.reset();
      onCancel();
    }
  }

  return (
    <form
      data-testid="project-alias-form"
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-3 border-t border-hairline bg-raised px-4 py-4 md:flex-row md:items-start md:px-6"
    >
      <TextField
        ref={draft.nameRef}
        label="Name"
        hideLabel
        autoFocus
        data-testid="project-alias-name"
        value={draft.name}
        onChange={(e) => draft.setName(e.target.value)}
        placeholder="api"
        suffix={`.${tld}`}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        error={draft.nameIssue}
        className="md:flex-1"
      />
      <TextField
        ref={draft.portRef}
        label="Port"
        hideLabel
        data-testid="project-alias-port"
        value={draft.port}
        onChange={(e) => draft.setPort(e.target.value)}
        placeholder="4000"
        prefix=":"
        inputMode="numeric"
        autoComplete="off"
        error={draft.portIssue}
        warning={draft.portNote}
        className="md:w-[8.5rem] md:shrink-0"
      />
      <div className="flex shrink-0 items-center gap-2">
        <Button size="md" variant="ghost" onClick={onCancel} data-testid="project-alias-cancel">
          Cancel
        </Button>
        <Button
          type="submit"
          size="md"
          variant="primary"
          busy={busy}
          data-testid="project-alias-submit"
        >
          Patch
        </Button>
      </div>
    </form>
  );
}
