import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // The app bundles Contents/Resources/dashboard and runs it with the embedded Bun.
  output: "standalone",
  // Tracing must start at the workspace root or @localhost-aliases/core is left out.
  outputFileTracingRoot: join(here, "..", ".."),
  // core ships TypeScript sources with explicit .ts extensions; Next has to compile them.
  transpilePackages: ["@localhost-aliases/core"],
  experimental: {
    // core lives outside this package's directory.
    externalDir: true,
  },
  // A dev server and a build in the same checkout must not share one .next directory.
  distDir: process.env.LA_NEXT_DIST ?? ".next",
  // Nothing here is deployed; the dashboard only ever serves 127.0.0.1.
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
