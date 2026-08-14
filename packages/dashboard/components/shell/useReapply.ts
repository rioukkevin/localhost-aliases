"use client";

import { useCallback, useState } from "react";
import * as api from "../../lib/client/api.ts";
import { refreshStatus } from "../../lib/client/status-store.ts";
import { useToast } from "../ui/Toast.tsx";

export interface Reapply {
  busy: boolean;
  /**
   * Only set when the last attempt needed root and *nothing could raise the prompt* —
   * then the exact command is the user's way out. While the menu-bar app is answering
   * it stays null, because showing a command the app is already running is noise.
   */
  intent: api.ApplyIntent | null;
  run: () => void;
}

/**
 * Re-apply, in the only way this process is allowed to — and the only way back from a
 * dismissed prompt, since nothing re-prompts on its own.
 *
 * The dashboard refreshes the files the forwarder and the privileged script read —
 * that alone closes port-only drift with no prompt at all. Anything that needs root
 * is *asked for*, not run: the menu-bar app picks the request up and raises the one
 * admin prompt. If it is not running we say so plainly rather than spin.
 *
 * Both surfaces that offer this — the drift banner and the status panel — go through
 * here, so they cannot end up doing two different things under the same words.
 */
export function useReapply(): Reapply {
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<api.ApplyIntent | null>(null);
  const toast = useToast();

  const run = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await api.prepareApply();
        if (!result.needsPrompt) {
          setIntent(null);
          toast.push({ tone: "success", title: "state re-applied" });
          return;
        }
        const asked = await api.requestPrivileged("apply");
        if (asked.request) {
          setIntent(null);
          toast.push({
            tone: "info",
            title: "asked the menu-bar app",
            detail: "Approve the admin prompt it raises; this page updates by itself.",
          });
        } else {
          setIntent(result.intent);
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

  return { busy, intent, run };
}
