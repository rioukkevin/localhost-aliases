"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import * as api from "../../lib/client/api.ts";

/**
 * Setup is not a page you have to find: on a Mac where it was never finished (and
 * never deliberately skipped) the dashboard hands you straight to it. Read once per
 * mount, never polled — the shared status poll stays the only timer in the app.
 */
export function useSetupGate(enabled: boolean): void {
  const router = useRouter();
  const asked = useRef(false);

  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    let cancelled = false;
    void api
      .fetchOnboarding()
      .then((payload) => {
        if (cancelled || payload.complete || payload.skipped) return;
        router.replace("/onboarding");
      })
      // A failed read is not a reason to move the user anywhere: stay put.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, router]);
}
