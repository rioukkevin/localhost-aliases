/**
 * The brand, in one place. These values are copied from the dashboard's design tokens
 * (packages/dashboard/app/globals.css) — if they ever disagree, globals.css wins and this
 * file is wrong. Every rendered asset reads from here so a colour cannot drift between
 * the app icon, the favicon, the OG card and the site.
 */
export const brand = {
  canvas: "#0a0a0b",
  raised: "#111113",
  ink: "#f2f2ef",
  muted: "#8a8a85",
  faint: "#55554f",
  accent: "#d6ff4b",
  accentInk: "#0a0a0b",
  live: "#4ade80",
  down: "#f5a524",
  danger: "#ff6b5a",
  hairline: "rgba(255,255,255,0.08)",
  mono: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif',
} as const;

export const productName = "Localhost Aliases";
export const tagline = "Give your local dev servers real names.";
