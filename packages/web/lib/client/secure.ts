"use client";

/**
 * What the padlock is allowed to say.
 *
 * The rule, and the only one that matters here: **never draw a padlock the browser would
 * not draw.** A closed lock is a promise that `https://myapp.local` opens without an
 * interstitial, so every condition that would break that promise has to demote it.
 *
 * Three things must all hold:
 *   1. HTTPS is switched on              — otherwise the URL is plain http and there is no lock
 *   2. the local CA is trusted by this Mac — otherwise the browser shows a warning
 *   3. the leaf on disk covers *this* hostname and the helper is serving TLS
 *
 * (3) is the one that is easy to forget: a brand-new alias has no certificate until the
 * next apply, so it is untrusted for a moment even on a perfectly configured machine.
 */
import type { SystemStatus } from "@localhost-aliases/core";

export type SecureState = "trusted" | "untrusted" | "http";

/** The extra `/api/status` fields the padlock reads. Optional so an older payload degrades. */
export type StatusWithTls = SystemStatus & {
  tls?: { enabled: boolean; listening: boolean; port: number; coveredHosts: string[] };
  ca?: SystemStatus["ca"] & { trustedIn?: ("system" | "login")[] };
};

export function secureStateFor(hostname: string, status: StatusWithTls | null): SecureState {
  if (!status?.https) return "http";
  if (!status.ca?.trusted) return "untrusted";

  const tls = status.tls;
  // No TLS block at all: trust the two facts we do have rather than inventing a third.
  if (!tls) return "trusted";
  if (!tls.listening) return "untrusted";
  return tls.coveredHosts.includes(hostname) ? "trusted" : "untrusted";
}

/** One sentence per state, written for a tooltip rather than a spec. */
export function secureExplanation(state: SecureState, hostname: string): string {
  switch (state) {
    case "trusted":
      return `${hostname} is served over HTTPS with a certificate this Mac trusts.`;
    case "untrusted":
      return `${hostname} is served over HTTPS, but this browser will warn: the certificate is not trusted yet.`;
    case "http":
      return `${hostname} is served over plain HTTP. Turn on HTTPS in Settings to get a certificate.`;
  }
}
