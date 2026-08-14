"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { WORKSPACE_FILENAME } from "@localhost-aliases/core/types";
import type { AliasView } from "@localhost-aliases/core/types";
import * as api from "../../lib/client/api.ts";
import { folderName } from "../../lib/client/format.ts";
import { refreshStatus, useStatus } from "../../lib/client/status-store.ts";
import { useToast } from "../ui/Toast.tsx";

/** One grid card's worth of facts. Everything here is derived, nothing is stored per folder. */
export interface ProjectSummary {
  path: string;
  name: string;
  aliases: AliasView[];
  live: number;
  hasWorkspaceFile: boolean;
}

export interface ProjectsHandle {
  projects: ProjectSummary[];
  /** A folder dialog / link call is in flight. */
  linking: boolean;
  /** The path whose workspace file is being written, or null. */
  writing: string | null;
  addProject: (path: string) => Promise<void>;
  writeWorkspace: (path: string) => Promise<void>;
}

/**
 * Projects are only a grouping: a folder is "a project" because an alias points at it.
 * The list therefore comes from the polled aliases, plus two things the aliases cannot
 * answer — whether the folder carries a workspace file, and folders you just added that
 * have no alias yet.
 */
export function useProjects(): ProjectsHandle {
  const { aliases } = useStatus();
  const toast = useToast();

  const [workspaceFiles, setWorkspaceFiles] = useState<Record<string, boolean>>({});
  // Every folder we have been told about, so a project you just added — or just emptied —
  // does not vanish from the grid under your cursor.
  const [known, setKnown] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);
  const [writing, setWriting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const projects = await api.fetchProjects();
      setWorkspaceFiles(Object.fromEntries(projects.map((p) => [p.path, p.hasWorkspaceFile])));
      setKnown((current) => [...new Set([...current, ...projects.map((p) => p.path)])]);
    } catch {
      // Best-effort: the folder list itself is already in the polled aliases.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const projects = useMemo(() => {
    const byPath = new Map<string, AliasView[]>();
    for (const path of known) byPath.set(path, []);
    for (const alias of aliases) {
      if (!alias.projectPath) continue;
      const list = byPath.get(alias.projectPath) ?? [];
      list.push(alias);
      byPath.set(alias.projectPath, list);
    }
    return [...byPath.entries()]
      .map(([path, owned]) => ({
        path,
        name: folderName(path),
        aliases: owned,
        live: owned.filter((a) => a.status === "up").length,
        hasWorkspaceFile: workspaceFiles[path] ?? false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }, [aliases, known, workspaceFiles]);

  /**
   * Choosing a folder does the obvious thing on its own: if the folder already declares
   * aliases in its workspace file, they are adopted immediately. That is the whole point
   * of committing the file — clone the repo, pick the folder, done.
   */
  const addProject = useCallback(
    async (path: string) => {
      setLinking(true);
      try {
        const result = await api.linkProject({ path, importWorkspace: true });
        await refreshStatus();
        setKnown((current) => [...new Set([...current, path])]);
        setWorkspaceFiles((current) => ({ ...current, [path]: result.project.hasWorkspaceFile }));
        if (result.created.length > 0) {
          toast.push({
            tone: "success",
            title: `imported ${result.created.length} alias${result.created.length === 1 ? "" : "es"} from ${WORKSPACE_FILENAME}`,
            detail: result.created.map((a) => a.hostname).join(", "),
          });
        } else {
          toast.push({ tone: "info", title: `${folderName(path)} added` });
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
    },
    [toast],
  );

  const writeWorkspace = useCallback(
    async (path: string) => {
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
    },
    [toast],
  );

  return { projects, linking, writing, addProject, writeWorkspace };
}
