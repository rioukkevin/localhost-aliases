"use client";

/**
 * The single client-side store for the Projects view.
 *
 * Projects are derived server-side from the `projectPath` of each alias, so this
 * store is read-mostly: the only mutation is `POST /api/projects/link`, which
 * both registers aliases and writes the workspace file.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AliasView, Project, WorkspaceAliasEntry } from "@localhost-aliases/core";
import * as api from "./api.ts";
import { ApiError } from "./api.ts";
import { useToast } from "../../components/Toast.tsx";

const POLL_MS = 5000;

export interface ProjectsStore {
  projects: Project[];
  /** Every alias, including the unlinked ones — used to warn about re-pointing. */
  aliases: AliasView[];
  /** Only used for previews in the link form; read once, not polled. */
  tld: string;
  loading: boolean;
  loadError: string | null;
  /** Path of the project currently being written, or "" for the link form. */
  busyPath: string | null;
  refresh: () => Promise<void>;
  link: (path: string, entries: WorkspaceAliasEntry[]) => Promise<api.LinkProjectResult | null>;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return issues.length > 0 ? issues : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function useProjects(): ProjectsStore {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [aliases, setAliases] = useState<AliasView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [tld, setTld] = useState("local");

  // A poll must not overwrite the list while a link is still in flight.
  const busyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextProjects, nextAliases] = await Promise.all([
        api.fetchProjects(),
        api.fetchAliases(),
      ]);
      if (busyRef.current === null) {
        setProjects(nextProjects);
        setAliases(nextAliases);
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(describe(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The TLD only changes from the Settings view, which reloads this page anyway.
    void api
      .fetchStatus()
      .then((status) => setTld(status.tld))
      .catch(() => undefined);
  }, [refresh]);

  // Same visibility-aware poll as the aliases view: status dots must stay live.
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
      if (document.hidden) stop();
      else {
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

  const link = useCallback(
    async (path: string, entries: WorkspaceAliasEntry[]) => {
      busyRef.current = path;
      setBusyPath(path);
      try {
        const result = await api.linkProject(path, entries);
        const summary = [
          result.created.length > 0 ? `created ${result.created.join(", ")}` : "",
          result.updated.length > 0 ? `re-pointed ${result.updated.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        toast.push({
          tone: result.warning ? "info" : "success",
          title: `Wrote ${result.workspacePath.split("/").pop()}`,
          detail: result.warning ?? (summary === "" ? result.workspacePath : summary),
        });
        return result;
      } catch (err) {
        toast.push({ tone: "error", title: "Could not link the folder", detail: describe(err) });
        return null;
      } finally {
        busyRef.current = null;
        setBusyPath(null);
        void refresh();
      }
    },
    [toast, refresh],
  );

  return { projects, aliases, tld, loading, loadError, busyPath, refresh, link };
}
