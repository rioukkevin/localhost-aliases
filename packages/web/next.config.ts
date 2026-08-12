import { resolve } from "node:path";
import type { NextConfig } from "next";
import { claimDistDir, conflictingServer, distDir } from "./lib/dist-lock.ts";

/**
 * Exported as a function so Next hands us the phase: only a *server* may own the build
 * directory, while a build merely warns (see lib/dist-lock.ts for why any of this exists).
 */
export default function config(phase: string): NextConfig {
  const conflict = conflictingServer();
  if (conflict !== null) {
    if (phase.includes("server")) throw new Error(`Refusing to start: ${conflict}`);
    console.warn(`[next.config] warning: ${conflict}`);
  } else if (phase.includes("server")) {
    claimDistDir();
  }

  return {
    // The dashboard is a local-only control panel: never index it, never phone home.
    poweredByHeader: false,
    reactStrictMode: true,
    // core is a source-only workspace package (TS, no build step), so Next must transpile it.
    transpilePackages: ["@localhost-aliases/core"],
    experimental: { externalDir: true },
    /*
     * The .app ships no node_modules and no checkout: `Contents/Resources/web` is the
     * standalone tree, booted as `bin/bun web/server.js`. Tracing has to be rooted at the
     * workspace root or the traced copy of @localhost-aliases/core (a symlink into
     * packages/core) lands outside the output and the server dies on first request.
     * cwd is packages/web (lib/dist-lock.ts relies on the same).
     */
    output: "standalone",
    outputFileTracingRoot: resolve(process.cwd(), "..", ".."),
    /*
     * Normally `.next`. A test (or a second server) sets LA_NEXT_DIST_DIR to get its own
     * build tree: `next dev` wipes and rebuilds whatever directory it is given, so sharing
     * one with the production build means every test run destroys it.
     */
    distDir: distDir(),
  };
}
