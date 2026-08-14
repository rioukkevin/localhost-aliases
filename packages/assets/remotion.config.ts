import { existsSync } from "node:fs";
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);

/**
 * Remotion normally downloads its own Chrome Headless Shell on first render. That download
 * is blocked in this environment ("Error: should have downloaded browser"), so we point it
 * at a Chrome that is already installed. REMOTION_BROWSER overrides. If neither exists —
 * a CI runner with network access, say — we stay silent and let Remotion fetch its own.
 */
const candidates = [
  process.env.REMOTION_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const browser = candidates.find((p) => existsSync(p));
if (browser) Config.setBrowserExecutable(browser);
