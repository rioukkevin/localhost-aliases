/**
 * Keeping the certificate in step with the aliases.
 *
 * The whole point of the https switch is that flipping it is all the user does. So this runs
 * on the same sync that writes the desired state: if https is on, the CA exists and the leaf
 * covers exactly today's hostnames — issued before routes.json is written, so the forwarder
 * never binds a TLS listener against a certificate that is not there yet.
 *
 * Two things it deliberately does NOT do:
 *
 *  - **Trust the CA.** That needs the user's password, so it is a button, not a side effect
 *    of a poll. An app that silently installs a trusted root is indistinguishable from malware.
 *  - **Fail the sync.** A certificate problem must never cost the user their aliases: http
 *    keeps working, the error is reported, and the UI says why the padlock is missing.
 */
import {
  aliasCertPath,
  aliasKeyPath,
  caExists,
  certExpiresInMs,
  certNeedsReissue,
  isCATrusted,
  issueAliasCert,
  trustCommand,
  type Config,
  type DesiredState,
} from "@localhost-aliases/core";

export interface TlsState {
  /** Whether the user has asked for https at all. */
  enabled: boolean;
  /** The CA exists on disk. */
  caReady: boolean;
  /** The user has granted it trust — without this the browser still warns. */
  trusted: boolean;
  /** The leaf covers today's hostnames and is not near expiry. */
  certReady: boolean;
  /** Days until the leaf expires, or null when there is no readable leaf. */
  expiresInDays: number | null;
  /** The exact command that grants trust, for the UI to run or show. */
  trustCommand: string;
  certPath: string;
  keyPath: string;
  /** Populated only when something went wrong; https then degrades to http. */
  error: string | null;
}

const IDLE: Omit<TlsState, "trustCommand" | "certPath" | "keyPath"> = {
  enabled: false,
  caReady: false,
  trusted: false,
  certReady: false,
  expiresInDays: null,
  error: null,
};

/**
 * Bring the certificate up to date for this desired state, and report where things stand.
 * Safe to call on every sync: issuing only happens when the hostname set changed or the leaf
 * is close to expiring, so the steady-state cost is two file stats.
 */
export async function ensureTls(config: Config, desired: DesiredState): Promise<TlsState> {
  const base = { trustCommand: trustCommand(), certPath: aliasCertPath(), keyPath: aliasKeyPath() };

  if (!config.https) {
    // Report the CA honestly even when https is off: the settings page wants to say
    // "already trusted" rather than make the user do it twice.
    return { ...IDLE, ...base, caReady: await caExists(), trusted: await isCATrusted() };
  }

  const hostnames = [...new Set(desired.hosts.map((h) => h.hostname))].sort();
  if (hostnames.length === 0) {
    return { ...IDLE, ...base, enabled: true, caReady: await caExists(), trusted: await isCATrusted() };
  }

  try {
    if (await certNeedsReissue(hostnames)) {
      await issueAliasCert(hostnames, [...new Set(desired.loopbackIps)]);
    }
    const left = await certExpiresInMs();
    return {
      ...base,
      enabled: true,
      caReady: true,
      trusted: await isCATrusted(),
      certReady: true,
      expiresInDays: left === null ? null : Math.floor(left / 86_400_000),
      error: null,
    };
  } catch (err) {
    // http keeps working; only the padlock is missing, and the UI can now say why.
    return {
      ...IDLE,
      ...base,
      enabled: true,
      caReady: await caExists(),
      trusted: await isCATrusted(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
