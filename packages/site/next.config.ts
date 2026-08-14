import type { NextConfig } from "next";

const config: NextConfig = {
  // Marketing site: no images pipeline, no server state, nothing to power-header.
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
