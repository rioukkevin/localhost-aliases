import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DriftBanner } from "../components/DriftBanner.tsx";
import { NavRail } from "../components/NavRail.tsx";
import { StatusStrip } from "../components/StatusStrip.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Localhost Aliases",
  description: "Real hostnames for the dev servers already running on this Mac.",
};

// No manual theme switch: the app follows the OS, and light is a full re-theme.
export const viewport: Viewport = { colorScheme: "dark light" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-accent focus:bg-raised focus:px-3 focus:py-2 focus:text-[13px]"
        >
          Skip to content
        </a>

        <ToastProvider>
          <NavRail />
          <div className="lg:pl-56">
            <StatusStrip />
            <main id="content">
              {/* empty:hidden keeps the spacing out of the way when nothing has drifted. */}
              <div className="mx-auto w-full max-w-5xl px-4 pt-8 empty:hidden md:px-8 md:pt-10">
                <DriftBanner />
              </div>
              {children}
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
