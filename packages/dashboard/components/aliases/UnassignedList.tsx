"use client";

import { useRef, useState } from "react";
import type { AliasView, CreateAliasInput, ValidationIssue } from "@localhost-aliases/core/types";
import { ApiError } from "../../lib/client/api.ts";
import { countLabel } from "../../lib/client/format.ts";
import { Button, Spinner } from "../ui/Button.tsx";
import { IconPlus } from "../ui/Icons.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Panel } from "../ui/Panel.tsx";
import { PatchCable } from "../ui/PatchCable.tsx";
import { AliasEditor } from "./AliasEditor.tsx";
import { AliasRows, AliasRowsSkeleton } from "./AliasRows.tsx";
import { useAliasApply } from "./alias-apply.ts";
import { useAliasActions } from "./useAliasActions.ts";

export interface UnassignedListProps {
  /** Every alias, so the editor can tell you a name is already taken. */
  aliases: AliasView[];
  tld: string;
  loaded: boolean;
  /** A mutation is in flight somewhere in the app. */
  busy: boolean;
}

/**
 * Everything that belongs to no folder, under the project grid — including the reserved
 * dashboard alias, which gets its own recessed header because it is the one row you
 * cannot rename or delete.
 *
 * The snapshot arrives as props rather than from the store: the page is the one place
 * wired to the poll, which keeps this component a pure function of what it is given.
 *
 * WHY THERE IS A BUTTON IN THE HEADER. The create form has always been here, in the
 * footer, and it has always worked. What it did not have was a way of being FOUND: it is
 * the last thing on the longest page in the app, its only heading was a 10px `text-faint`
 * caption that reads as a legend rather than a control, and the one add-shaped affordance
 * above the fold belonged to the projects grid ("Add a project"). A user scanning the page
 * could reasonably conclude that an alias without a folder was not a thing you could make.
 * So the panel header now says "New alias" where the eye already is, and it scrolls to the
 * form and focuses its first field rather than opening a second one — two forms that both
 * create aliases is exactly the duplication this component was written to avoid.
 */
export function UnassignedList({ aliases, tld, loaded, busy }: UnassignedListProps) {
  const actions = useAliasActions();
  const applyOf = useAliasApply();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Remounting the form is the whole reset: no field state survives a successful create.
  const [formKey, setFormKey] = useState(0);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const formRef = useRef<HTMLDivElement>(null);

  /** Take the user to the form that already exists, rather than opening a second one. */
  function focusForm() {
    const root = formRef.current;
    if (!root) return;
    root.scrollIntoView({ behavior: "smooth", block: "center" });
    root.querySelector("input")?.focus({ preventScroll: true });
  }

  const loose = aliases.filter((a) => !a.projectPath && !a.reserved);
  const reserved = aliases.filter((a) => !a.projectPath && a.reserved);
  const live = loose.filter((a) => a.status === "up").length;

  async function create(input: CreateAliasInput) {
    setCreating(true);
    setServerIssues([]);
    try {
      await actions.create(input);
      setFormKey((n) => n + 1);
    } catch (err) {
      // The toast already said what happened; put field problems back on their fields.
      if (err instanceof ApiError) setServerIssues(err.issues);
    } finally {
      setCreating(false);
    }
  }

  const rowProps = {
    aliases,
    tld,
    editingId,
    applyOf,
    onEdit: setEditingId,
    onSave: (id: string, input: CreateAliasInput) => actions.update(id, input).catch(() => {}),
    onDelete: (alias: AliasView) => actions.remove(alias).catch(() => {}),
    onDetach: (alias: AliasView) => actions.move(alias, null).catch(() => {}),
  };

  return (
    <Panel
      title="unassigned"
      meta={loaded ? `${countLabel(loose.length, "alias", "aliases")} · ${live} live` : "…"}
      padded={false}
      data-testid="unassigned-list"
      aside={
        <>
          {busy ? (
            <span role="status" className="flex items-center gap-1.5 text-[11px] text-accent">
              <Spinner />
              applying…
            </span>
          ) : null}
          <Button size="sm" onClick={focusForm} data-testid="new-alias">
            <IconPlus />
            New alias
          </Button>
        </>
      }
      footer={
        <div className="flex flex-col gap-3" ref={formRef} data-testid="new-alias-form">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h3 className="text-[13px] font-semibold tracking-tight text-ink">New alias</h3>
            <p className="mono text-[11px] text-faint">127.0.0.x:80 → 127.0.0.1:port</p>
          </div>
          <p className="max-w-2xl text-[12.5px] leading-relaxed text-muted">
            A folder is optional. Leave it empty and the name lives in this list.
          </p>
          <AliasEditor
            key={formKey}
            aliases={aliases}
            tld={tld}
            submitLabel="Patch it"
            busy={creating}
            serverIssues={serverIssues}
            onSubmit={create}
          />
        </div>
      }
    >
      {!loaded ? (
        <AliasRowsSkeleton />
      ) : (
        <>
          {reserved.length > 0 ? (
            <section className="@container" data-testid="reserved-section">
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 bg-sunken px-4 py-2 @2xl:px-8">
                <h3 className="mono text-[12px] text-ink">the dashboard itself</h3>
                <p className="text-[11px] text-faint">
                  reserved — it cannot be renamed or deleted
                </p>
              </header>
              <AliasRows rows={reserved} legend={false} {...rowProps} />
            </section>
          ) : null}

          {loose.length === 0 ? (
            <EmptyState
              title="Every alias belongs to a folder"
              actions={
                <Button variant="primary" size="sm" onClick={focusForm} data-testid="new-alias-empty">
                  <IconPlus />
                  New alias
                </Button>
              }
              figure={
                <div className="flex items-center gap-3 opacity-70">
                  <span className="mono text-[15px] text-faint">myapp.{tld}</span>
                  <PatchCable status="up" size="figure" className="flex-1" />
                  <span className="mono text-[15px] text-faint">:3000</span>
                </div>
              }
            >
              Names patched here have no project — which is perfectly normal. Use{" "}
              <span className="text-ink">New alias</span> above, or the form at the bottom of
              this panel, and the name stays in this list until you give it a folder.
            </EmptyState>
          ) : (
            <AliasRows rows={loose} legend {...rowProps} />
          )}
        </>
      )}
    </Panel>
  );
}
