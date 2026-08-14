import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/shell/AppShell.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Localhost Aliases",
  description: "Real hostnames for the dev servers already running on this Mac.",
};

// No manual theme switch: the app follows the OS, and light is a full re-theme.
export const viewport: Viewport = { colorScheme: "dark light" };

/**
 * Stays a server component: the chrome needs a pathname, a drawer and a poll, so all
 * of that lives in AppShell and this file keeps rendering the document itself.
 */
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
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
