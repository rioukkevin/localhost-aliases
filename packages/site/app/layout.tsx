import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "../components/site/SiteFooter.tsx";
import { SiteHeader } from "../components/site/SiteHeader.tsx";
import { siteUrl } from "../lib/site.ts";
import "./globals.css";

const TITLE = "Localhost Aliases";
const DESCRIPTION =
  "Real hostnames for the dev servers already running on your Mac. http://myapp.local instead of http://localhost:3000 — one admin prompt, nothing permanently installed.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: TITLE, template: `%s — ${TITLE}` },
  description: DESCRIPTION,
  applicationName: TITLE,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `${TITLE} — names patched to ports` }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/apple-touch-icon.png",
  },
  // Without this the manifest is never fetched, so icon-512 and maskable-512 — both
  // rendered, committed and synced — are dead weight and an installed PWA falls back to a
  // screenshot of the page.
  manifest: "/site.webmanifest",
};

// No manual theme switch: the site follows the OS, exactly like the app.
export const viewport: Viewport = { colorScheme: "dark light" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-accent focus:bg-raised focus:px-3 focus:py-2 focus:text-[13px]"
        >
          Skip to content
        </a>

        <SiteHeader />
        <main id="content" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
