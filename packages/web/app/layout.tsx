import type { Metadata, Viewport } from "next";
import "./globals.css";
import { NavRail } from "../components/NavRail.tsx";
import { StatusStrip } from "../components/StatusStrip.tsx";
import { ToastProvider } from "../components/Toast.tsx";

export const metadata: Metadata = {
  title: "Localhost Aliases",
  description: "Give your local dev servers real names.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark light",
};

/**
 * Server component. The only client islands in the shell are the nav (needs the
 * active route) and the status strip (needs a poll).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <ToastProvider>
          <a
            href="#content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-accent focus:bg-raised focus:px-3 focus:py-2 focus:text-[13px]"
          >
            Skip to content
          </a>
          <NavRail />
          <div className="flex min-h-screen flex-col lg:pl-56">
            <StatusStrip />
            <main id="content" className="flex-1">
              {children}
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
