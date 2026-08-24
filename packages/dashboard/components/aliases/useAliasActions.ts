"use client";

import { DEFAULT_TLD } from "@localhost-aliases/core/types";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";
import * as api from "../../lib/client/api.ts";
import { folderName, pendingAlias } from "../../lib/client/format.ts";
import { mutateAliases, useStatus } from "../../lib/client/status-store.ts";
import { useToast } from "../ui/Toast.tsx";

/**
 * Every alias mutation, in one place: optimistic edit, rollback on failure, a toast
 * that names what happened. Both the patchbay and the projects view use it, so a
 * rename behaves identically wherever it is triggered.
 */
export function useAliasActions() {
  const toast = useToast();
  const { config } = useStatus();
  const tld = config?.tld ?? DEFAULT_TLD;

  function fail(title: string, err: unknown): never {
    toast.push({ tone: "error", title, detail: api.errorMessage(err) });
    throw err;
  }

  return {
    tld,

    async create(input: CreateAliasInput): Promise<void> {
      try {
        await mutateAliases(
          (list) => [...list, pendingAlias(input, tld)],
          () => api.createAlias(input),
        );
        toast.push({ tone: "success", title: `${input.name}.${tld} patched to :${input.port}` });
      } catch (err) {
        fail("Change rejected", err);
      }
    },

    async update(id: string, input: CreateAliasInput): Promise<void> {
      const before = { ...input };
      try {
        await mutateAliases(
          (list) =>
            list.map((a) =>
              a.id === id
                ? {
                    ...a,
                    ...before,
                    hostname: `${before.name}.${tld}`,
                    url: `http://${before.name}.${tld}`,
                  }
                : a,
            ),
          () => api.updateAlias(id, input),
        );
        toast.push({ tone: "success", title: `${before.name}.${tld} updated` });
      } catch (err) {
        fail("Change rejected", err);
      }
    },

    async remove(alias: AliasView): Promise<void> {
      try {
        await mutateAliases(
          (list) => list.filter((a) => a.id !== alias.id),
          () => api.deleteAlias(alias.id),
        );
        toast.push({ tone: "success", title: `${alias.hostname} unpatched` });
      } catch (err) {
        fail("Change rejected", err);
      }
    },

    async move(alias: AliasView, projectPath: string | null): Promise<void> {
      try {
        await mutateAliases(
          (list) => list.map((a) => (a.id === alias.id ? { ...a, projectPath } : a)),
          () => api.updateAlias(alias.id, { projectPath }),
        );
        toast.push({
          tone: "success",
          title: projectPath
            ? `${alias.hostname} moved to ${folderName(projectPath)}`
            : `${alias.hostname} detached from its folder`,
        });
      } catch (err) {
        fail("Change rejected", err);
      }
    },
  };
}
