/**
 * Everything the dashboard knows about TLS, in one place.
 *
 * Two responsibilities that must not be confused:
 *
 *  - *material* — the CA and the leaf on disk. That is core's `certs.ts`.
 *  - *reality*  — whether this Mac, right now, opens `https://myapp.local` without a
 *    warning. Nothing on disk can answer that, so it is answered by making the request.
 *
 * The reality check shells `/usr/bin/curl`, which on macOS is linked against
 * SecureTransport and therefore consults the same keychain Safari and Chrome do. A fetch
 * from inside Bun would not: Bun ships its own CA bundle and would call a perfectly
 * trusted certificate untrusted. That distinction is the whole point of the check.
 */
import {
  buildRoutes,
  caCertPath,
  caExists,
  caTrustState,
  ensureCA,
  leafSans,
  loadConfig,
  loginKeychainPath,
  loginTrustCommand,
  trustCAInLoginKeychain,
  trustCommand,
  type Config,
  type TrustStore,
} from "@localhost-aliases/core";

const CURL = "/usr/bin/curl";
/** Loopback: either it answers immediately or it is not there. */
const CURL_TIMEOUT_SECONDS = 5;

export interface CertsPayload {
  /** The CA exists on disk. */
  generated: boolean;
  path: string | null;
  /** A TLS client on this Mac accepts it — see `caTrustState`. */
  trusted: boolean;
  /** Keychains holding this exact certificate. */
  stores: TrustStore[];
  fingerprint: string | null;
  loginKeychain: string;
  /** The trust one-liners, for the copy-paste fallback. */
  commands: { login: string; system: string };
  /** Hostnames the leaf currently on disk covers. A hostname not in here has no cert. */
  coveredHosts: string[];
  https: boolean;
  httpsPort: number;
}

export async function getCerts(): Promise<CertsPayload> {
  const config = await loadConfig();
  const generated = caExists();
  const state = generated
    ? await caTrustState()
    : { trusted: false, stores: [] as TrustStore[], fingerprint: null };

  return {
    generated,
    path: generated ? caCertPath() : null,
    trusted: state.trusted,
    stores: state.stores,
    fingerprint: state.fingerprint,
    loginKeychain: loginKeychainPath(),
    commands: { login: loginTrustCommand(), system: trustCommand() },
    coveredHosts: generated ? await leafSans() : [],
    https: config.https,
    httpsPort: config.httpsPort,
  };
}

/** Creates the CA if it is missing. Never regenerates: the user has trusted this one. */
export async function generateCA(): Promise<{ created: boolean; certs: CertsPayload }> {
  const { created } = await ensureCA();
  return { created, certs: await getCerts() };
}

/**
 * Adds the CA to the login keychain. macOS raises a password dialog for this, so it is
 * only ever reached from an explicit click in onboarding — never from a poll, a startup
 * hook or a test (`LA_TRUST_STUB` short-circuits it, and the e2e environment sets it).
 */
export async function trustCA(): Promise<{
  ok: boolean;
  error: string | null;
  stubbed: boolean;
  certs: CertsPayload;
}> {
  const outcome = await trustCAInLoginKeychain();
  return {
    ok: outcome.ok,
    error: outcome.error,
    stubbed: outcome.stubbed,
    certs: await getCerts(),
  };
}

// ---------------------------------------------------------------------------
// The live check
// ---------------------------------------------------------------------------

export type VerifyOutcome =
  /** The browser would show a closed padlock. */
  | "trusted"
  /** Our leaf is being served, but this Mac does not trust the CA that signed it. */
  | "untrusted"
  /** Something is answering TLS, but not with a certificate from our CA. */
  | "foreign-certificate"
  /** Nothing is listening on the TLS port, or it is not speaking TLS. */
  | "unreachable"
  /** HTTPS is switched off, or there is no CA yet — nothing to check. */
  | "not-applicable";

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** The URL that was actually requested. */
  url: string;
  hostname: string;
  port: number;
  /** HTTP status the upstream returned, when the request got that far. */
  httpStatus: number | null;
  /** One line, safe to show: curl's own error, trimmed. */
  detail: string;
  /** ISO-8601. A verification result is only meaningful next to when it was taken. */
  checkedAt: string;
}

interface CurlRun {
  exitCode: number;
  httpStatus: number;
  stderr: string;
}

function runCurl(url: string, hostname: string, port: number, cacert: string | null): CurlRun {
  const proc = Bun.spawnSync([
    CURL,
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--max-time",
    String(CURL_TIMEOUT_SECONDS),
    // The hostname may not be in /etc/hosts yet (the helper writes it), and the check
    // must not depend on that: it is testing TLS, not name resolution.
    "--resolve",
    `${hostname}:${port}:127.0.0.1`,
    ...(cacert === null ? [] : ["--cacert", cacert]),
    url,
  ]);
  return {
    exitCode: proc.exitCode ?? -1,
    httpStatus: Number(proc.stdout.toString().trim()) || 0,
    stderr: proc.stderr.toString().trim(),
  };
}

/** The first hostname worth checking: a real alias if there is one, loopback otherwise. */
function checkTarget(config: Config): string {
  return buildRoutes(config)[0]?.host ?? "localhost";
}

/**
 * Makes one real HTTPS request and reports what a browser would conclude.
 *
 * Two requests, not one, because "it failed" is useless on its own:
 *   - without `--cacert`, curl uses the keychain → is this Mac happy?
 *   - with `--cacert`, curl uses only our CA    → is the helper even serving our leaf?
 *
 * The pair separates "you have not trusted the CA yet" (fixable in one click) from
 * "something else owns that port" (not fixable by trusting anything).
 */
export async function verifyHttps(hostnameOverride?: string): Promise<VerifyResult> {
  const config = await loadConfig();
  const hostname = hostnameOverride?.trim() || checkTarget(config);
  const port = config.httpsPort;
  const url = `https://${hostname}:${port}/`;
  const checkedAt = new Date().toISOString();
  const base = { url, hostname, port, httpStatus: null, checkedAt };

  if (!config.https) {
    return { ...base, outcome: "not-applicable", detail: "HTTPS is switched off in settings." };
  }
  if (!caExists()) {
    return { ...base, outcome: "not-applicable", detail: "There is no local CA yet." };
  }

  const keychain = runCurl(url, hostname, port, null);
  if (keychain.exitCode === 0) {
    return {
      ...base,
      outcome: "trusted",
      httpStatus: keychain.httpStatus,
      detail: `curl completed the TLS handshake using the macOS keychain and got HTTP ${keychain.httpStatus}.`,
    };
  }

  const ours = runCurl(url, hostname, port, caCertPath());
  if (ours.exitCode === 0) {
    return {
      ...base,
      outcome: "untrusted",
      httpStatus: ours.httpStatus,
      detail:
        "The helper is serving the right certificate, but this Mac does not trust the " +
        "certificate authority that signed it yet.",
    };
  }

  // Both failed. Distinguish "nobody is there" from "somebody else is there".
  const reachable = ours.exitCode !== 7 && ours.exitCode !== 28;
  return {
    ...base,
    outcome: reachable ? "foreign-certificate" : "unreachable",
    detail: (ours.stderr || keychain.stderr || `curl exited ${ours.exitCode}`).split("\n")[0] ?? "",
  };
}
