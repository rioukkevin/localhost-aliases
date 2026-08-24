/**
 * Which suffix a local alias may end in. Pure data plus one predicate; no I/O.
 *
 * A local alias is only ever `http://<name>.<tld>` pointed at a loopback IP by /etc/hosts.
 * Two whole families of TLD break that, and both break it *quietly* — the user sees a
 * mysterious delay or a certificate error, never an honest "you picked a bad suffix".
 * So they are rejected outright rather than warned about.
 *
 *   1. mDNS. macOS hands `.local` to mDNSResponder (RFC 6762 reserves it for Bonjour),
 *      which waits for a multicast answer before it will fall back. The OS states the
 *      timeout itself — `scutil --dns` lists `domain: local / options: mdns / timeout: 5`.
 *      Measured on macOS 26.3: a `.local` name costs ~5.0s per getaddrinfo whether or not
 *      it is in /etc/hosts, while the same name under `.test` costs ~0.001-0.003s. A name
 *      absent from /etc/hosts costs the same 5s, so the penalty is the SUFFIX, not the lookup.
 *   2. HSTS preload. Chrome and Safari ship a preload list that force-upgrades http:// to
 *      https:// for every name under certain TLDs. Our forwarder splices raw TCP and never
 *      sees the bytes, so nothing in the path can terminate TLS: the browser fails with a
 *      TLS error that points nowhere near the real cause.
 *
 * The default is `.test`, which RFC 6761 reserves for exactly this use: never publicly
 * resolvable, not intercepted by mDNS, and resolved straight out of /etc/hosts.
 */

/** RFC 6761 §6.2. The one suffix guaranteed safe for local development names. */
export const DEFAULT_TLD = "test";

/** Suffixes macOS routes to mDNSResponder instead of the normal resolver. */
export const MDNS_TLDS = ["local"] as const;

/**
 * TLDs on the Chromium HSTS preload list as whole-TLD, include-subdomains entries — the
 * Google-operated gTLDs plus `.gay`. Every name under these is https-only in Chrome, Edge
 * and Safari, which an http-only alias can never satisfy.
 */
export const HSTS_PRELOADED_TLDS = [
  "android", "app", "bank", "boo", "channel", "chrome", "dad", "day", "dev", "eat", "esq",
  "fly", "foo", "gay", "gbiz", "gle", "gmail", "google", "hangout", "ing", "insurance",
  "meet", "meme", "mov", "new", "nexus", "page", "phd", "play", "prod", "prof", "rsvp",
  "search", "soy", "xn--q9jyb4c", "zip",
] as const;

/**
 * `.localhost` is not blocked for the reasons above but for a third one: macOS resolves
 * every name under it to 127.0.0.1 on its own (RFC 6761 §6.3), ignoring /etc/hosts. Each
 * alias owns its own 127.0.0.x, so the name would resolve past the forwarder to a port 80
 * nothing is listening on.
 */
export const SELF_RESOLVING_TLDS = ["localhost"] as const;

/** Offered in the UI. Every one of these is reserved or private by standard, and resolves from /etc/hosts. */
export const SAFE_TLDS = ["test", "internal", "lan", "home.arpa", "example"] as const;

/**
 * The LAST label decides. `.dev` is HSTS-preloaded for every name under it, so `foo.dev` is
 * just as broken as `dev`; the same holds for `.local` and `.localhost`.
 */
function finalLabel(tld: string): string {
  const labels = tld.trim().toLowerCase().split(".");
  return labels[labels.length - 1] ?? "";
}

function has(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/**
 * Why this TLD cannot be used, or null if it can.
 *
 * The message is specific per reason on purpose: told only "not allowed", a developer just
 * tries the next broken suffix on the list.
 */
export function blockedTldReason(tld: string): string | null {
  const suffix = finalLabel(tld);

  if (has(MDNS_TLDS, suffix)) {
    return `.${suffix} is reserved by macOS for Bonjour/mDNS, so every lookup waits about 5 seconds for a multicast answer — even for a name that is in /etc/hosts. Use .${DEFAULT_TLD}, which resolves in about 8ms.`;
  }
  if (has(HSTS_PRELOADED_TLDS, suffix)) {
    return `.${suffix} is HSTS-preloaded in Chrome and Safari, so they force http:// up to https://. Aliases here are raw TCP forwards that can never terminate TLS, so the browser would fail with a confusing certificate error. Use .${DEFAULT_TLD} instead.`;
  }
  if (has(SELF_RESOLVING_TLDS, suffix)) {
    return `.${suffix} is resolved to 127.0.0.1 by macOS itself, ignoring /etc/hosts, so an alias would never reach its own loopback address. Use .${DEFAULT_TLD} instead.`;
  }
  return null;
}

/** True when the suffix is usable. Convenience for the UI; the reason is the useful part. */
export function isUsableTld(tld: string): boolean {
  return blockedTldReason(tld) === null;
}
