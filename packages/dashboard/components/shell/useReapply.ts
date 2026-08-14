"use client";

import { useCallback, useState } from "react";
import * as api from "../../lib/client/api.ts";
import { refreshStatus } from "../../lib/client/status-store.ts";
import { useToast } from "../ui/Toast.tsx";

export interface Reapply {
  busy: boolean;
  run: () => void;
}

/**
 * Re-apply, in the only way this process is allowed to.
 *
 * The dashboard refreshes the files the forwarder and the privileged script read —
 * that alone closes port-only drift with no prompt at all. Anything that needs root
 * is *asked for*, not run: the menu-bar app picks the request up and raises the one
 * admin prompt. If it is not running we say so plainly rather than spin.
 */
export function useReapply(): Reapply {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await api.prepareApply();
        if (!result.needsPrompt) {
          toast.push({ tone: "success", title: "state re-applied" });
          return;
        }
        const asked = await api.requestPrivileged("apply");
        if (asked.request) {
          toast.push({
            tone: "info",
            title: "asked the menu-bar app",
            detail: "Approve the admin prompt it raises; this page updates by itself.",
          });
        } else {
          toast.push({
            tone: "error",
            title: "Nothing can raise the prompt",
            detail: asked.error ?? "The menu-bar app is not running.",
          });
        }
      } catch (err) {
        toast.push({ tone: "error", title: "Could not re-apply", detail: api.errorMessage(err) });
      } finally {
        setBusy(false);
        await refreshStatus();
      }
    })();
  }, [toast]);

  return { busy, run };
}
