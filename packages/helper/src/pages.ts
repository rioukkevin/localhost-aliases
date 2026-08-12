/**
 * The three pages the proxy serves itself. Self-contained: inline CSS, no fonts, no images,
 * no scripts — they must render on a machine where nothing else is running.
 *
 * Visual language is the dashboard's patchbay: hairlines, flat surfaces, one lime accent,
 * hostnames in monospace as the hero element. Dark is the default; light comes from
 * `prefers-color-scheme` so the page never flashes.
 */
import { dashboardUrl, type Route } from "@localhost-aliases/core";

/** Hostnames are validated before they ever get here; escaping is belt-and-braces. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root {
  color-scheme: dark light;
  --canvas: #0A0A0B; --raised: #111113; --line: rgba(255,255,255,0.08);
  --ink: #F2F2EF; --muted: #8A8A85; --accent: #D6FF4B; --amber: #F5A524; --danger: #FF6B5A;
}
@media (prefers-color-scheme: light) {
  :root {
    --canvas: #FAFAF8; --raised: #FFFFFF; --line: rgba(0,0,0,0.10);
    --ink: #111112; --muted: #6B6B66; --accent: #5B7A00; --amber: #A66300; --danger: #C0392B;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; background: var(--canvas); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
  display: flex; align-items: center; justify-content: center; padding: 8vh 24px;
  -webkit-font-smoothing: antialiased;
}
main { width: 100%; max-width: 640px; }
.eyebrow {
  font: 11px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .18em;
  text-transform: uppercase; color: var(--muted); display: flex; gap: .6em; align-items: center;
}
.eyebrow .code { color: var(--amber); }
.eyebrow .code.bad { color: var(--danger); }
h1 {
  margin: 18px 0 0; font: 600 clamp(28px, 6vw, 42px)/1.1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: -0.03em; word-break: break-all;
}
p { margin: 14px 0 0; color: var(--muted); max-width: 52ch; }
p strong { color: var(--ink); font-weight: 500; }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
/* The patch cable: name on the left, port on the right, a dimmed static line between. */
.patch { display: flex; align-items: center; gap: 14px; margin-top: 26px; }
.patch .jack {
  width: 9px; height: 9px; border-radius: 50%; flex: none;
  border: 1px solid var(--line); background: var(--raised);
}
.patch .jack.live { background: var(--accent); border-color: var(--accent); }
.patch .cable { flex: 1; height: 1px; background: repeating-linear-gradient(90deg, var(--line) 0 6px, transparent 6px 12px); }
.patch .port { font: 13px/1 ui-monospace, "SF Mono", Menlo, monospace; color: var(--muted); }
.hint {
  margin-top: 24px; border: 1px solid var(--line); background: var(--raised);
  padding: 14px 16px; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; color: var(--ink);
  overflow-x: auto; white-space: pre;
}
ul { list-style: none; margin: 22px 0 0; padding: 0; }
li { border-top: 1px solid var(--line); }
li:last-child { border-bottom: 1px solid var(--line); }
li a {
  display: flex; justify-content: space-between; gap: 16px; align-items: baseline;
  padding: 12px 2px; text-decoration: none; color: var(--ink);
  font: 15px/1.3 ui-monospace, "SF Mono", Menlo, monospace;
}
li a:hover, li a:focus-visible { color: var(--accent); }
li a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
li a .to { color: var(--muted); font-size: 13px; }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; }
footer .dot { color: var(--accent); }
`;

function shell(title: string, body: string, refreshSeconds?: number): string {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer><span class="dot">&#9679;</span> localhost-aliases</footer>
</main>
</body>
</html>
`;
}

function htmlResponse(status: number, html: string, extra: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // These pages are transient states of the world, never a cacheable answer.
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/** External URL for a known alias, including the listener port when it is not the default. */
function aliasUrl(host: string, proto: string, listenerPort: number): string {
  const isDefault = (proto === "http" && listenerPort === 80) || (proto === "https" && listenerPort === 443);
  return isDefault ? `${proto}://${host}` : `${proto}://${host}:${listenerPort}`;
}

export interface PageContext {
  proto: string;
  listenerPort: number;
}

/**
 * 404: the Host header matched no alias. Lists everything that *is* routed, as links, so a
 * typo is one click from being fixed.
 */
export function unknownHostPage(requestedHost: string | null, routes: Route[], ctx: PageContext): Response {
  const shown = requestedHost === null ? "(no Host header)" : requestedHost;
  const list =
    routes.length === 0
      ? `<p>No aliases are routed yet. Open the dashboard at <code>${esc(dashboardUrl())}</code> to create one.</p>`
      : `<ul>${routes
          .map((route) => {
            const url = aliasUrl(route.host, ctx.proto, ctx.listenerPort);
            return `<li><a href="${esc(url)}">${esc(route.host)}<span class="to">&rarr; :${route.port}</span></a></li>`;
          })
          .join("")}</ul>`;
  return htmlResponse(
    404,
    shell(
      `${shown} is not an alias`,
      `<div class="eyebrow"><span class="code bad">404</span><span>unknown host</span></div>
<h1>${esc(shown)}</h1>
<p>Nothing is patched to that name. ${routes.length === 0 ? "" : "These are the aliases this machine currently answers for:"}</p>
${list}`,
    ),
  );
}

/**
 * 502 offline: the alias is routed but nothing is listening upstream. Auto-refreshes so the
 * page turns into the real app the moment the dev server boots.
 */
export function offlinePage(route: Route): Response {
  return htmlResponse(
    502,
    shell(
      `${route.host} — nothing on :${route.port}`,
      `<div class="eyebrow"><span class="code">502</span><span>upstream offline</span></div>
<h1>${esc(route.host)}</h1>
<div class="patch">
  <span class="jack live"></span><span class="cable"></span>
  <span class="jack"></span><span class="port">${esc(route.target)}:${route.port}</span>
</div>
<p>The alias resolves and this proxy is up, but <strong>nothing is listening on ${esc(route.target)}:${route.port}</strong>.
Start the dev server for this project and the page will load itself.</p>
<div class="hint"># e.g.
bun dev --port ${route.port}</div>
<hr>
<p>Retrying every 3 seconds&hellip;</p>`,
      3,
    ),
    { "retry-after": "3" },
  );
}

/** 502: the upstream accepted the connection but the exchange failed. No auto-refresh. */
export function upstreamErrorPage(route: Route, detail: string): Response {
  return htmlResponse(
    502,
    shell(
      `${route.host} — upstream error`,
      `<div class="eyebrow"><span class="code bad">502</span><span>upstream error</span></div>
<h1>${esc(route.host)}</h1>
<div class="patch">
  <span class="jack live"></span><span class="cable"></span>
  <span class="jack live"></span><span class="port">${esc(route.target)}:${route.port}</span>
</div>
<p>The server on <strong>${esc(route.target)}:${route.port}</strong> answered, then the request failed:</p>
<div class="hint">${esc(detail)}</div>`,
    ),
  );
}
