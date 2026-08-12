"use client";

/**
 * The single client-side store for aliases — and therefore for projects, which
 * are nothing but aliases grouped by their optional `projectPath`. Both the
 * Projects view and the Aliases view own one instance of it and pass props down.
 *
 * Mutations are optimistic. The snapshot taken before each mutation is the
 * rollback target, and any failure both restores it and raises an error toast.
 *
 * System status is NOT read here: it comes from the shared store in
 * `useSystemStatus.ts`, which owns the only `/api/status` poll in the document.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AliasView,
  CreateAliasInput,
  UpdateAliasInput,
  WorkspaceAliasEntry,
} from "@localhost-aliases/core";
import * as api from "./api.ts";
import { ApiError } from "./api.ts";
import { folderName } from "./grouping.ts";
import { WORKSPACE_FILENAME } from "./paths.ts";
import { useSystemStatus, type StatusWithCommands } from "./useSystemStatus.ts";
import { useToast } from "../../components/Toast.tsx";

const POLL_MS = 5000;

export interface AliasesStoreOptions {
  /**
   * Also poll `/api/projects`. Only the Projects view needs it, and only for
   * one fact the alias list cannot carry: whether a folder holds a workspace
   * file. Off by default so the Aliases view costs one request per tick.
   */
  withWorkspaceFiles?: boolean;
}

export interface AliasesStore {
  aliases: AliasView[];
  /** Project folders known to hold a `.localhost-aliases.json`. */
  workspaceFiles: Set<string>;
  status: StatusWithCommands | null;
  /** True until the first successful (or failed) load; drives the skeleton. */
  loading: boolean;
  /** Set when the API itself is unreachable or erroring — shown as a banner. */
  loadError: string | null;
  /** True while a mutation is in flight and the helper is reconciling. */
  applying: boolean;
  /** Project folder whose workspace file is being written, if any. */
  busyPath: string | null;
  refresh: () => Promise<void>;
  create: (input: CreateAliasInput) => Promise<boolean>;
  update: (id: string, patch: UpdateAliasInput) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Attach, move or (with null) detach an alias. `projectPath` stays optional. */
  setProject: (id: string, projectPath: string | null) => Promise<boolean>;
  /** Writes/merges the workspace file for a folder from the aliases it holds. */
  writeWorkspace: (path: string) => Promise<boolean>;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return issues.length > 0 ? issues : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function useAliases(options: AliasesStoreOptions = {}): AliasesStore {
  const withWorkspaceFiles = options.withWorkspaceFiles ?? false;
  const toast = useToast();
  const { status } = useSystemStatus();
  const [aliases, setAliases] = useState<AliasView[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  // A poll must never clobber an optimistic list that a mutation still owns.
  const pendingRef = useRef(0);
  const aliasesRef = useRef<AliasView[]>([]);
  aliasesRef.current = aliases;

  const refresh = useCallback(async () => {
    try {
      const [next, projects] = await Promise.all([
        api.fetchAliases(),
        withWorkspaceFiles ? api.fetchProjects() : Promise.resolve(null),
      ]);
      if (pendingRef.current === 0) setAliases(next);
      if (projects) {
        const flagged = new Set(
          projects.filter((project) => project.hasWorkspaceFile).map((project) => project.path),
        );
        // Identity matters: a fresh Set every 5s would re-render every card.
        setWorkspaceFiles((current) => (sameMembers(current, flagged) ? current : flagged));
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(describe(err));
    } finally {
      setLoading(false);
    }
  }, [withWorkspaceFiles]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll for liveness, but only while the tab is actually being looked at.
  useEffect(() => {
    let timer: number | undefined;

    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => void refresh(), POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void refresh();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const runMutation = useCallback(
    async <T,>(optimistic: AliasView[], action: () => Promise<T>): Promise<T | null> => {
      const snapshot = aliasesRef.current;
      pendingRef.current += 1;
      setPending((n) => n + 1);
      setAliases(optimistic);
      try {
        return await action();
      } catch (err) {
        setAliases(snapshot); // rollback
        toast.push({ tone: "error", title: "Change rejected", detail: describe(err) });
        return null;
      } finally {
        pendingRef.current -= 1;
        setPending((n) => n - 1);
      }
    },
    [toast],
  );

  const create = useCallback(
    async (input: CreateAliasInput) => {
      const tld = status?.tld ?? "local";
      const draft: AliasView = {
        id: `pending-${Date.now()}`,
        name: input.name,
        port: input.port,
        target: input.target ?? "127.0.0.1",
        projectPath: input.projectPath ?? null,
        description: input.description ?? null,
        enabled: input.enabled ?? true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hostname: `${input.name}.${tld}`,
        url: `${status?.https ? "https" : "http"}://${input.name}.${tld}`,
        status: "unknown",
      };
      const result = await runMutation([...aliasesRef.current, draft], () =>
        api.createAlias(input),
      );
      if (!result) return false;
      toast.push({
        tone: result.warning ? "info" : "success",
        title: `${result.alias.hostname} patched to :${result.alias.port}`,
        detail: result.warning,
      });
      void refresh(); // reconcile in the background; do not block the form reset
      return true;
    },
    [runMutation, refresh, toast, status],
  );

  const update = useCallback(
    async (id: string, patch: UpdateAliasInput) => {
      const optimistic = aliasesRef.current.map((a) => (a.id === id ? { ...a, ...patch } : a));
      const result = await runMutation(optimistic as AliasView[], () => api.updateAlias(id, patch));
      if (!result) return false;
      toast.push({ tone: "success", title: `${result.alias.hostname} updated` });
      void refresh();
      return true;
    },
    [runMutation, refresh, toast],
  );

  const remove = useCallback(
    async (id: string) => {
      const target = aliasesRef.current.find((a) => a.id === id);
      const optimistic = aliasesRef.current.filter((a) => a.id !== id);
      const result = await runMutation(optimistic, async () => {
        await api.deleteAlias(id);
        return true as const;
      });
      if (!result) return false;
      toast.push({ tone: "success", title: `${target?.hostname ?? "Alias"} unpatched` });
      void refresh();
      return true;
    },
    [runMutation, refresh, toast],
  );

  const setProject = useCallback(
    async (id: string, projectPath: string | null) => {
      const target = aliasesRef.current.find((a) => a.id === id);
      const from = target?.projectPath ?? null;
      const optimistic = aliasesRef.current.map((a) => (a.id === id ? { ...a, projectPath } : a));
      const result = await runMutation(optimistic, () =>
        api.updateAlias(id, { projectPath }),
      );
      if (!result) return false;
      toast.push({
        tone: "success",
        title:
          projectPath === null
            ? `${result.alias.hostname} detached from ${from ? folderName(from) : "its project"}`
            : `${result.alias.hostname} moved to ${folderName(projectPath)}`,
        detail: projectPath === null ? "The alias still resolves; it just has no folder." : projectPath,
      });
      void refresh();
      return true;
    },
    [runMutation, refresh, toast],
  );

  const writeWorkspace = useCallback(
    async (path: string) => {
      const entries: WorkspaceAliasEntry[] = aliasesRef.current
        .filter((alias) => alias.projectPath === path)
        .map((alias) => ({
          name: alias.name,
          port: alias.port,
          ...(alias.description ? { description: alias.description } : {}),
        }));

      setBusyPath(path);
      try {
        const result = await api.linkProject(path, entries);
        toast.push({
          tone: result.warning ? "info" : "success",
          title: `Wrote ${WORKSPACE_FILENAME}`,
          detail: result.warning ?? result.workspacePath,
        });
        return true;
      } catch (err) {
        toast.push({
          tone: "error",
          title: "Could not write the workspace file",
          detail: describe(err),
        });
        return false;
      } finally {
        setBusyPath(null);
        void refresh();
      }
    },
    [toast, refresh],
  );

  return {
    aliases,
    workspaceFiles,
    status,
    loading,
    loadError,
    applying: pending > 0,
    busyPath,
    refresh,
    create,
    update,
    remove,
    setProject,
    writeWorkspace,
  };
}
