import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, NEXT_DIST_DIR, REPO_ROOT, withE2eEnv } from "./fixtures/paths";

/**
 * The dashboard is booted through its own package script. `bun --bun next start`
 * is not decoration: launching `next` directly re-execs under Node, where every
 * route handler dies with "ReferenceError: Bun is not defined" (see the runtime
 * pitfall section of docs/ARCHITECTURE.md).
 *
 * A missing production build is built once rather than reported as a timeout,
 * because "did you run build first?" is not a useful test failure.
 */
const START_DASHBOARD =
  `[ -f packages/web/${NEXT_DIST_DIR}/BUILD_ID ] || bun run --cwd packages/web build; ` +
  "exec bun run --cwd packages/web start";

export default defineConfig({
  testDir: "./tests",
  // One dashboard, one config file, one hosts file, one helper socket: the whole
  // suite shares a single world, so it runs serially by construction.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./fixtures/global-setup.ts",
  globalTeardown: "./fixtures/global-teardown.ts",

  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // The copy-URL affordance is part of the contract; reading it back needs both.
    permissions: ["clipboard-read", "clipboard-write"],
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: START_DASHBOARD,
    cwd: REPO_ROOT,
    url: `${BASE_URL}/api/health`,
    // A cold `next build` is minutes on a slow machine; a wedged server is not
    // worth waiting that long for, so this is generous but finite.
    timeout: 240_000,
    // Never adopt a stray server: it would be pointed at the real config dir.
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    // Explicitly inherited: the command needs PATH, and the LA_* overrides are
    // what keep the dashboard off the real config dir and the real /etc/hosts.
    env: withE2eEnv(),
  },
});
