"use client";

import { useCallback, useEffect, useState } from "react";
import { WORKSPACE_FILENAME } from "@localhost-aliases/core/types";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";
import * as api from "../../lib/client/api.ts";
import { countLabel, folderName, tildePath } from "../../lib/client/format.ts";
import { refreshStatus, useStatus } from "../../lib/client/status-store.ts";
import { AliasEditor } from "../aliases/AliasEditor.tsx";
import { AliasMini } from "../aliases/AliasMini.tsx";
import { useAliasActions } from "../aliases/useAliasActions.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Panel } from "../ui/Panel.tsx";
import { useToast } from "../ui/Toast.tsx";
import { FolderPicker } from "./FolderPicker.tsx";

/**
 * Projects are only a grouping: a folder is "a project" because an alias points at it.
 * Nothing is stored per folder unless you ask for the optional workspace file.
 */
export function ProjectsView() {
  const { aliases, config, loaded } = useStatus();
  const actions = useAliasActions();
  const toast = useToast();
  const tld = config?.tld ?? "local";

  const [picked, setPicked] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState<string | null>(null);
  // hasWorkspaceFile is the only fact the alias list cannot answer; read on demand.
  const [workspaceFiles, setWorkspaceFiles] = useState<Record<string, boolean>>({});

  const loadProjects = useCallback(async () => {
    try {
      const projects = await api.fetchProjects();
      setWorkspaceFiles(Object.fromEntries(projects.map((p) => [p.path, p.hasWorkspaceFile])));
    } catch {
      // best-effort: the folder list itself comes from the polled aliases
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const paths = [...new Set(aliases.filter((a) => a.projectPath).map((a) => a.projectPath!))].sort();
  const unassigned = aliases.filter((a) => !a.projectPath && !a.reserved);
  const shownPaths = picked && !paths.includes(picked) ? [picked, ...paths] : paths;

  /**
   * Choosing a folder does the obvious thing on its own: if the folder already declares
   * aliases in its workspace file, they are adopted immediately. That is the whole
   * point of committing the file — clone the repo, pick the folder, done.
   */
  async function choose(path: string | null) {
    setPicked(path);
    if (!path) return;
    setLinking(true);
    try {
      const result = await api.linkProject({ path, importWorkspace: true });
      await refreshStatus();
      setWorkspaceFiles((current) => ({
        ...current,
        [path]: result.project.hasWorkspaceFile,
      }));
      if (result.created.length > 0) {
        toast.push({
          tone: "success",
          title: `imported ${result.created.length} alias${result.created.length === 1 ? "" : "es"} from ${WORKSPACE_FILENAME}`,
          detail: result.created.map((a) => a.hostname).join(", "),
        });
      }
    } catch (err) {
      toast.push({
        tone: "error",
        title: "Could not read that folder",
        detail: api.errorMessage(err),
      });
    } finally {
      setLinking(false);
    }
  }

  async function attach(alias: AliasView, path: string) {
    try {
      await api.linkProject({ path, aliasIds: [alias.id] });
      await refreshStatus();
      toast.push({ tone: "success", title: `${alias.hostname} moved to ${folderName(path)}` });
    } catch (err) {
      toast.push({ tone: "error", title: "Change rejected", detail: api.errorMessage(err) });
    }
  }

  async function createIn(path: string, input: CreateAliasInput) {
    setCreating(true);
    try {
      await actions.create({ ...input, projectPath: path });
      setPicked(null);
    } catch {
      // toasted and rolled back already
    } finally {
      setCreating(false);
    }
  }

  async function writeWorkspace(path: string) {
    setWriting(path);
    try {
      const written = await api.writeWorkspaceFile(path);
      setWorkspaceFiles((current) => ({ ...current, [path]: true }));
      toast.push({ tone: "success", title: `wrote ${WORKSPACE_FILENAME}`, detail: written });
    } catch (err) {
      toast.push({
        tone: "error",
        title: "Could not write the workspace file",
        detail: api.errorMessage(err),
      });
    } finally {
      setWriting(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel title="add a folder" meta="optional grouping">
        <div className="flex flex-col gap-4">
          <FolderPicker value={picked} onChange={(path) => void choose(path)} label="Folder" disabled={linking} />
          {picked ? (
            <div className="border-t border-hairline pt-4">
              <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
                Patch a name to a server running in{" "}
                <span className="mono text-ink">{tildePath(picked)}</span>, or attach one of the
                aliases that has no folder yet.
              </p>
              <AliasEditor
                aliases={aliases}
                tld={tld}
                fixedProjectPath={picked}
                submitLabel="Patch it here"
                busy={creating}
                onSubmit={(input) => createIn(picked, input)}
                onCancel={() => setPicked(null)}
              />
              {unassigned.length > 0 ? (
                <AttachRow aliases={unassigned} onAttach={(alias) => void attach(alias, picked)} />
              ) : null}
            </div>
          ) : null}
        </div>
      </Panel>

      {loaded && shownPaths.length === 0 ? (
        <Panel title="folders" padded={false}>
          <EmptyState title="No folders yet">
            Aliases work perfectly well with no folder — this view only groups them. Choose a
            folder above when you want to see one project&apos;s names together.
          </EmptyState>
        </Panel>
      ) : null}

      {shownPaths.map((path) => {
        const owned = aliases.filter((a) => a.projectPath === path);
        const hasFile = workspaceFiles[path] ?? false;
        return (
          <Panel
            key={path}
            title={folderName(path)}
            meta={tildePath(path)}
            aside={hasFile ? <Chip tone="accent">{WORKSPACE_FILENAME}</Chip> : null}
            data-testid="project-panel"
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-xl text-[12px] leading-relaxed text-muted">
                  {hasFile
                    ? `${WORKSPACE_FILENAME} lives in this folder and lists these names, so a teammate who clones the repo can recreate them. It is optional; deleting it changes nothing here.`
                    : `Optional: write ${WORKSPACE_FILENAME} into this folder so the names travel with the repo. Nothing here depends on it.`}
                </p>
                <Button
                  size="sm"
                  busy={writing === path}
                  onClick={() => void writeWorkspace(path)}
                >
                  {hasFile ? "Rewrite file" : "Write file"}
                </Button>
              </div>
            }
          >
            {owned.length === 0 ? (
              <p className="text-[13px] text-muted">
                No aliases point at this folder yet.
              </p>
            ) : (
              <>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
                  {countLabel(owned.length, "alias", "aliases")}
                </p>
                <ul className="divide-y divide-hairline">
                  {owned.map((alias) => (
                    <AliasMini
                      key={alias.id}
                      alias={alias}
                      onDetach={(a) => void actions.move(a, null).catch(() => {})}
                    />
                  ))}
                </ul>
              </>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function AttachRow({
  aliases,
  onAttach,
}: {
  aliases: AliasView[];
  onAttach: (alias: AliasView) => void;
}) {
  const [selected, setSelected] = useState(aliases[0]?.id ?? "");
  const alias = aliases.find((a) => a.id === selected) ?? aliases[0];

  return (
    <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          Attach an existing alias
        </span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.currentTarget.value)}
          className="mono h-10 border border-hairline-strong bg-sunken px-2.5 text-[15px] text-ink"
        >
          {aliases.map((a) => (
            <option key={a.id} value={a.id}>
              {a.hostname}
            </option>
          ))}
        </select>
      </label>
      <Button size="md" disabled={!alias} onClick={() => alias && onAttach(alias)}>
        Attach
      </Button>
    </div>
  );
}
