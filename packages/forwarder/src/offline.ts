/**
 * The offline page — the one place a raw TCP forwarder is allowed to speak HTTP.
 *
 * v1 served this from an HTTP proxy. v2 forwards raw bytes, so the page comes back on the
 * FAILURE PATH ONLY: the working path never looks at a byte. When the upstream connect
 * fails we peek at what the client sent first:
 *
 *   - it starts with an HTTP method token  -> write a 503 and close
 *   - anything else                        -> close without writing
 *
 * The second case is not politeness. A Postgres client, an SSH client or a WebSocket that
 * got an HTML document where its protocol expected a frame does not show the user a nice
 * error; it shows a corruption bug. Inventing a response for a protocol we do not speak is
 * worse than saying nothing.
 *
 * The page itself is self-contained: inline CSS, no fetch, no font, no image. It keeps the
 * alias URL in the address bar (it is a 503 on that URL, not a redirect), follows
 * docs/DESIGN.md, and auto-refreshes so it turns into the real app the moment the dev
 * server boots.
 */
import type { Route } from "@localhost-aliases/core/types";

export type HttpVerdict = "http" | "not-http" | "unknown";

/**
 * Methods worth recognising: RFC 9110 plus the WebDAV-ish ones a dev server may see. The
 * list is closed on purpose — "looks texty" is not evidence of HTTP.
 */
const METHODS = [
  "GET",
  "PUT",
  "HEAD",
  "POST",
  "PATCH",
  "TRACE",
  "DELETE",
  "OPTIONS",
  "CONNECT",
] as const;

/** Longest method plus its trailing space: all the bytes a verdict can ever need. */
export const SNIFF_BYTES = Math.max(...METHODS.map((m) => m.length)) + 1;

/**
 * Is this the start of an HTTP request?
 *
 * `"unknown"` means "not enough bytes yet": the prefix is still consistent with a method,
 * so the caller should wait for more rather than guess. An empty read is `"unknown"` too —
 * a client that connected and said nothing has not told us what it is.
 */
export function sniffHttpRequest(bytes: Uint8Array): HttpVerdict {
  const head = String.fromCharCode(...bytes.subarray(0, SNIFF_BYTES));
  let couldStillBe = false;
  for (const method of METHODS) {
    const token = `${method} `;
    if (head.startsWith(token)) return "http";
    if (head.length < token.length && token.startsWith(head)) couldStillBe = true;
  }
  return couldStillBe ? "unknown" : "not-http";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The dashboard's own alias, derived from this alias's TLD: `api.myapp.test` -> `index.test`.
 * Null when the hostname has no TLD to borrow, in which case the link is simply omitted
 * rather than pointed somewhere that does not resolve.
 */
export function dashboardOfflineUrl(hostname: string): string | null {
  const labels = hostname.split(".");
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!tld) return null;
  return `http://index.${tld}/offline?host=${encodeURIComponent(hostname)}`;
}

/** How often the page reloads itself, in seconds. Short enough to feel automatic. */
const RELOAD_SECONDS = 2;

/**
 * docs/DESIGN.md verbatim, trimmed to what one page uses. Dark is `:root`, light is a
 * `prefers-color-scheme` override — the same shape as the dashboard, so the two do not
 * drift into different greys.
 */
const CSS = `
:root{--canvas:#0a0a0b;--raised:#111113;--sunken:#060607;--hairline:rgba(255,255,255,.08);
--hairline-strong:rgba(255,255,255,.16);--ink:#f2f2ef;--muted:#8a8a85;--faint:#55554f;
--accent:#d6ff4b;--down:#f5a524}
@media (prefers-color-scheme:light){:root{--canvas:#fafaf8;--raised:#fff;--sunken:#f1f1ed;
--hairline:rgba(0,0,0,.1);--hairline-strong:rgba(0,0,0,.2);--ink:#111112;--muted:#6b6b66;
--faint:#a3a39c;--accent:#5b7a00;--down:#b45309}}
*{box-sizing:border-box;border-color:var(--hairline)}
html,body{margin:0;background:var(--canvas);color:var(--ink)}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",ui-sans-serif,system-ui,sans-serif;
-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
font-feature-settings:"ss01","zero";letter-spacing:-.02em}
main{width:100%;max-width:34rem}
.rack{border:1px solid var(--hairline);background:var(--canvas)}
.rack-head{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--hairline);
background:var(--raised);padding:10px 16px}
.label{font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.18em;color:var(--faint)}
.lamp{width:6px;height:6px;border-radius:9999px;background:var(--down);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
.body{padding:22px 16px 20px}
h1{margin:0;font-size:19px;font-weight:500;line-height:1.25}
h1 .tld{color:var(--faint)}
.url{margin-top:6px;font-size:11px;color:var(--faint)}
.cable{display:block;width:100%;height:28px;color:var(--down);margin:18px 0}
.port{font-size:17px;text-align:right;color:var(--down)}
.port .colon{color:var(--faint)}
p{margin:0;font-size:13px;line-height:1.6;color:var(--muted)}
p+p{margin-top:10px}
.cmd-label{margin:20px 0 6px;font-size:10px;font-weight:500;text-transform:uppercase;
letter-spacing:.16em;color:var(--faint)}
.cmd{border:1px solid var(--hairline-strong);background:var(--sunken)}
.cmd pre{margin:0;padding:10px 12px;font-size:12px;line-height:1.6;color:var(--ink);
white-space:pre-wrap;word-break:break-word}
footer{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;
border-top:1px solid var(--hairline);padding:14px 16px;font-size:11px;color:var(--faint)}
footer a{color:var(--accent)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;
animation-iteration-count:1!important;transition-duration:.001ms!important}}
`.trim();

/** The dashed patch cable, in the "down" tone — DESIGN.md: it only drifts when the upstream is up. */
const CABLE = `<svg class="cable" role="presentation" aria-hidden="true" focusable="false" height="28">
<circle cx="9" cy="14" r="5.5" fill="none" stroke="currentColor" stroke-width="1" opacity=".55"/>
<circle cx="9" cy="14" r="2" fill="currentColor"/>
<g transform="translate(-9,0)">
<line x1="18" y1="14" x2="100%" y2="14" stroke="currentColor" stroke-width="1.25"
stroke-dasharray="6 6" stroke-linecap="round" opacity=".45"/>
<circle cx="100%" cy="14" r="5.5" fill="none" stroke="currentColor" stroke-width="1" opacity=".55"/>
<circle cx="100%" cy="14" r="2" fill="currentColor"/>
</g></svg>`;

/**
 * The whole page for one dead route. Everything interpolated is escaped: `hostname` has
 * already been validated, but `hint.command` came out of a file the agent does not trust.
 */
export function offlinePage(route: Route): string {
  const hostname = escapeHtml(route.hostname);
  const labels = route.hostname.split(".");
  const name = escapeHtml(labels.slice(0, -1).join("."));
  const tld = labels.length > 1 ? `.${escapeHtml(labels[labels.length - 1] ?? "")}` : "";
  const port = String(route.targetPort);
  const dashboard = dashboardOfflineUrl(route.hostname);

  const hint = route.hint
    ? `<div class="cmd-label">start ${escapeHtml(route.hint.framework)} on this port</div>
<div class="cmd"><pre class="mono">${escapeHtml(route.hint.command)}</pre></div>`
    : `<div class="cmd-label">no command known</div>
<p>this folder is not a stack we recognise, so start it however you normally do — just
make it listen on port ${port}.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${RELOAD_SECONDS}">
<meta name="color-scheme" content="dark light">
<title>no server on :${port} — ${hostname}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<section class="rack">
<header class="rack-head"><span class="lamp"></span><span class="label">no server</span></header>
<div class="body">
<h1 class="mono">${name}<span class="tld">${tld}</span></h1>
<div class="url mono">http://${hostname}</div>
${CABLE}
<div class="port mono"><span class="colon">:</span>${port}</div>
<p>the alias resolves and this connection reached the forwarder. nothing is listening on
port ${port}, so there is nothing to forward to yet.</p>
<p>your dev server is not touched, and neither is anything else on this machine — start it
and this page becomes your app.</p>
${hint}
</div>
<footer>
<span>retrying every ${RELOAD_SECONDS}s</span>
${dashboard ? `<a href="${escapeHtml(dashboard)}">open the dashboard</a>` : ""}
<span class="mono">localhost-aliases</span>
</footer>
</section>
</main>
</body>
</html>
`;
}

/**
 * The full 503, headers included, ready to write to the socket.
 *
 * `Connection: close` and an explicit `Content-Length` because we close immediately after:
 * a keep-alive promise we do not intend to honour makes the browser wait for nothing.
 * `Cache-Control: no-store` so the failure is never what the user sees after the server
 * comes back.
 */
export function offlineResponse(route: Route): Uint8Array {
  const body = new TextEncoder().encode(offlinePage(route));
  const head = new TextEncoder().encode(
    [
      "HTTP/1.1 503 Service Unavailable",
      "Content-Type: text/html; charset=utf-8",
      `Content-Length: ${body.byteLength}`,
      "Cache-Control: no-store",
      `Retry-After: ${RELOAD_SECONDS}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  return out;
}
