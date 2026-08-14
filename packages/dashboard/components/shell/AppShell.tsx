"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { DriftBanner } from "../DriftBanner.tsx";
import { AppMark } from "../ui/AppMark.tsx";
import { Button } from "../ui/Button.tsx";
import { IconGear } from "../ui/Icons.tsx";
import { SettingsDrawer } from "./SettingsDrawer.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { useSetupGate } from "./useSetupGate.ts";

/**
 * The whole chrome, and all of it: a mark top left, one control top right, an
 * instrument lamp bottom right. No nav — there is one page, and everything global
 * lives in a drawer over it.
 *
 * Setup is the exception: it is a full-screen route with no chrome at all, because
 * until it has run there is nothing for the chrome to report on.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const bare = pathname.startsWith("/onboarding");
  const [settingsOpen, setSettingsOpen] = useState(false);
  useSetupGate(!bare);

  // Leaving the page closes the drawer: coming back from setup to a drawer you
  // never reopened would be the app remembering something you did not ask it to.
  useEffect(() => {
    setSettingsOpen(false);
  }, [pathname]);

  // "#settings" is the only way another route can reach into this drawer — setup's
  // https step sends you here. The hash is consumed so a reload does not reopen it.
  useEffect(() => {
    function check() {
      if (window.location.hash !== "#settings") return;
      setSettingsOpen(true);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [pathname]);

  if (bare) return <main id="content">{children}</main>;

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-hairline bg-canvas px-4 py-3 md:px-8">
        <span className="flex items-center">
          <AppMark className="text-accent" />
          <span className="sr-only">Localhost Aliases</span>
        </span>

        <Button
          variant="ghost"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(true)}
          data-testid="open-settings"
        >
          <IconGear />
          Settings
        </Button>
      </header>

      <main id="content">
        {/* empty:hidden keeps the spacing out of the way when nothing has drifted. */}
        <div className="mx-auto w-full max-w-5xl px-4 pt-8 empty:hidden md:px-8 md:pt-10">
          <DriftBanner />
        </div>
        {children}
      </main>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <StatusIndicator />
    </>
  );
}
