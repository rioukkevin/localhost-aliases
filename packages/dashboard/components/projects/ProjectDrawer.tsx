"use client";

import { useState } from "react";
import { WORKSPACE_FILENAME } from "@localhost-aliases/core/types";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";
import * as api from "../../lib/client/api.ts";
import { countLabel, tildePath } from "../../lib/client/format.ts";
import { refreshStatus } from "../../lib/client/status-store.ts";
import { AliasEditor } from "../aliases/AliasEditor.tsx";
import { AliasRows } from "../aliases/AliasRows.tsx";
import { useAliasApply } from "../aliases/alias-apply.ts";
import { useAliasActions } from "../aliases/useAliasActions.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { useToast } from "../ui/Toast.tsx";
import type { ProjectSummary } from "./useProjects.ts";

export interface ProjectDrawerProps {
  /** null means closed. */
  project: ProjectSummary | null;
  /** Every alias, for name-collision checks and the attach picker. */
  aliases: AliasView[];
  tld: string;
  onClose: () => void;
  onWriteWorkspace: (path: string) => Promise<void>;
  /** The path currently being written, from useProjects. */
  writing: string | null;
}

/**
 * One project, opened from its card: the folder's patch cables and everything you can do
 * to them. Same rows as the unassigned list — a rename behaves identically wherever it
 * is triggered.
 */
export function ProjectDrawer({
  project,
  aliases,
  tld,
  onClose,
  onWriteWorkspace,
  writing,
}: ProjectDrawerProps) {
  const actions = useAliasActions();
  const applyOf = useAliasApply();
  const toast = useToast();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [attaching, setAttaching] = useState(false);

  const path = project?.path ?? null;
  const owned = project?.aliases ?? [];
  const unassigned = aliases.filter((a) => !a.projectPath && !a.reserved);

  async function create(input: CreateAliasInput) {
    if (!path) return;
    setCreating(true);
    try {
      await actions.create({ ...input, projectPath: path });
      setFormKey((n) => n + 1);
    } catch {
      // toasted and rolled back already
    } finally {
      setCreating(false);
    }
  }

  async function attach(alias: AliasView) {
    if (!path) return;
    setAttaching(true);
    try {
      await api.linkProject({ path, aliasIds: [alias.id] });
      await refreshStatus();
      toast.push({ tone: "success", title: `${alias.hostname} moved to ${project?.name}` });
    } catch (err) {
      toast.push({ tone: "error", title: "Change rejected", detail: api.errorMessage(err) });
    } finally {
      setAttaching(false);
    }
  }

  return (
    <Drawer
      open={project !== null}
      onClose={onClose}
      side="right"
      title={project?.name ?? ""}
      data-testid="project-drawer"
      headerAccessory={
        project ? (
          <Chip tone={project.live > 0 ? "live" : "muted"} dot>
            {project.live} / {project.aliases.length} live
          </Chip>
        ) : null
      }
    >
      {project ? (
        <div className="flex flex-col gap-6">
          {/* The path is machine-literal, so it is set in mono here rather than passed
              to the drawer's plain-text subtitle slot. */}
          <div className="flex min-w-0 items-center gap-2">
            <p className="mono min-w-0 flex-1 truncate text-[12px] text-muted" title={project.path}>
              {tildePath(project.path)}
            </p>
            {project.hasWorkspaceFile ? (
              <Chip tone="accent" className="shrink-0">
                {WORKSPACE_FILENAME}
              </Chip>
            ) : null}
          </div>

          {/* No negative margins: the drawer owns its padding and we do not know it. */}
          <section className="border border-hairline @container">
            <h3 className="border-b border-hairline bg-raised px-4 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
              patchbay — {countLabel(owned.length, "alias", "aliases")}
            </h3>
            {owned.length === 0 ? (
              <p className="px-4 py-6 text-[13px] leading-relaxed text-muted">
                No aliases point at this folder yet. Patch one below, or attach a name that
                has no folder.
              </p>
            ) : (
              <AliasRows
                rows={owned}
                aliases={aliases}
                tld={tld}
                editingId={editingId}
                applyOf={applyOf}
                hideProjectPath
                onEdit={setEditingId}
                onSave={(id, input) => actions.update(id, input).catch(() => {})}
                onDelete={(alias) => actions.remove(alias).catch(() => {})}
                onDetach={(alias) => actions.move(alias, null).catch(() => {})}
              />
            )}
          </section>

          <section>
            <h3 className="mb-3 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
              new alias in this folder
            </h3>
            <AliasEditor
              key={formKey}
              aliases={aliases}
              tld={tld}
              fixedProjectPath={path}
              submitLabel="Patch it here"
              busy={creating}
              onSubmit={create}
            />
          </section>

          {unassigned.length > 0 ? (
            <AttachRow
              aliases={unassigned}
              busy={attaching}
              onAttach={(alias) => void attach(alias)}
            />
          ) : null}

          <section className="border-t border-hairline pt-5">
            <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
              workspace file — optional
            </h3>
            <p className="mb-3 max-w-prose text-[12.5px] leading-relaxed text-muted">
              {project.hasWorkspaceFile
                ? `${WORKSPACE_FILENAME} lives in this folder and lists these names, so a teammate who clones the repo can recreate them. It is optional; deleting it changes nothing here.`
                : `Write ${WORKSPACE_FILENAME} into this folder so the names travel with the repo. Nothing here depends on it.`}
            </p>
            <Button
              size="sm"
              busy={writing === project.path}
              onClick={() => void onWriteWorkspace(project.path)}
            >
              {project.hasWorkspaceFile ? "Rewrite file" : "Write file"}
            </Button>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

function AttachRow({
  aliases,
  busy,
  onAttach,
}: {
  aliases: AliasView[];
  busy: boolean;
  onAttach: (alias: AliasView) => void;
}) {
  const [selected, setSelected] = useState("");
  const alias = aliases.find((a) => a.id === selected) ?? aliases[0];

  return (
    <section className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          Attach an existing alias
        </span>
        <select
          value={alias?.id ?? ""}
          onChange={(e) => setSelected(e.currentTarget.value)}
          className="mono h-10 min-w-0 border border-hairline-strong bg-sunken px-2.5 text-[15px] text-ink"
        >
          {aliases.map((a) => (
            <option key={a.id} value={a.id}>
              {a.hostname}
            </option>
          ))}
        </select>
      </label>
      <Button size="md" busy={busy} disabled={!alias} onClick={() => alias && onAttach(alias)}>
        Attach
      </Button>
    </section>
  );
}
