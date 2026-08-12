/**
 * The local certificate authority.
 *
 * Implemented by shelling out to `/usr/bin/openssl` (LibreSSL, always present on macOS) with
 * a generated config file. A config file rather than `-addext` because LibreSSL's `openssl`
 * does not support `-addext`; `-config` / `-extfile` work on both LibreSSL and OpenSSL.
 *
 * The one rule that matters: the CA is generated once and never again. The user trusts that
 * exact certificate in their System keychain, and silently regenerating it would break every
 * previously issued leaf while looking like it worked.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { caCertPath, caDir, caKeyPath, leafCertPath, leafKeyPath } from "./paths.ts";

const OPENSSL = "/usr/bin/openssl";
const SECURITY = "/usr/bin/security";
const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

export const CA_COMMON_NAME = "localhost-aliases Local CA";
const ORGANISATION = "localhost-aliases";

const CA_DAYS = 3650; // 10 years: the user only trusts this once.
/** macOS refuses server certificates valid for more than 398 days. */
const LEAF_DAYS = 397;
const LEAF_EXT_SECTION = "v3_leaf";
/** X.509 caps a common name at 64 characters. SANs are what clients actually check. */
const MAX_COMMON_NAME_LENGTH = 64;

/** Always covered so the dashboard and direct loopback access work under the same cert. */
const IMPLICIT_SANS = ["localhost", "127.0.0.1", "::1"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Every SAN value the leaf must carry: the given hostnames plus loopback, deduped, in order. */
export function buildSans(hostnames: string[]): string[] {
  const sans: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...hostnames, ...IMPLICIT_SANS]) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    sans.push(value);
  }
  return sans;
}

/** An IPv6 literal always contains ':', an IPv4 literal is only digits and dots. */
function isIpLiteral(value: string): boolean {
  return value.includes(":") || /^[0-9.]+$/.test(value);
}

/** openssl wants SANs split into numbered `DNS.n` / `IP.n` entries. */
function altNamesSection(sans: string[]): string {
  const lines: string[] = [];
  let dns = 0;
  let ip = 0;
  for (const value of sans) {
    if (isIpLiteral(value)) {
      ip += 1;
      lines.push(`IP.${ip} = ${value}`);
    } else {
      dns += 1;
      lines.push(`DNS.${dns} = ${value}`);
    }
  }
  return lines.join("\n");
}

function leafCommonName(sans: string[]): string {
  const first = sans[0];
  return first && first.length <= MAX_COMMON_NAME_LENGTH ? first : "localhost";
}

function caConfig(): string {
  return [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3_ca",
    "prompt = no",
    "",
    "[dn]",
    `CN = ${CA_COMMON_NAME}`,
    `O = ${ORGANISATION}`,
    "",
    "[v3_ca]",
    "basicConstraints = critical, CA:TRUE, pathlen:0",
    "keyUsage = critical, keyCertSign, cRLSign",
    "subjectKeyIdentifier = hash",
    "",
  ].join("\n");
}

function leafConfig(sans: string[]): string {
  return [
    "[req]",
    "distinguished_name = dn",
    `req_extensions = ${LEAF_EXT_SECTION}`,
    "prompt = no",
    "",
    "[dn]",
    `CN = ${leafCommonName(sans)}`,
    `O = ${ORGANISATION}`,
    "",
    `[${LEAF_EXT_SECTION}]`,
    "basicConstraints = CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    altNamesSection(sans),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// openssl
// ---------------------------------------------------------------------------

async function runOpenssl(args: string[]): Promise<void> {
  const proc = Bun.spawn([OPENSSL, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`openssl ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// CA
// ---------------------------------------------------------------------------

export function caExists(): boolean {
  return existsSync(caCertPath()) && existsSync(caKeyPath());
}

/**
 * Creates the root CA if it is missing, and does nothing at all if it is not. `created` tells
 * the caller which happened, so the UI can prompt for keychain trust only on a fresh CA.
 */
export async function ensureCA(): Promise<{ certPath: string; keyPath: string; created: boolean }> {
  const certPath = caCertPath();
  const keyPath = caKeyPath();
  if (caExists()) return { certPath, keyPath, created: false };

  const dir = caDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const configPath = join(dir, "ca.cnf");
  await writeFile(configPath, caConfig(), { mode: 0o600 });
  try {
    await runOpenssl([
      "req",
      "-x509",
      "-new",
      "-newkey",
      "rsa:4096",
      "-sha256",
      "-nodes",
      "-days",
      String(CA_DAYS),
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-config",
      configPath,
    ]);
    await chmod(keyPath, 0o600); // private key: owner only.
    await chmod(certPath, 0o644);
  } finally {
    await rm(configPath, { force: true });
  }
  return { certPath, keyPath, created: true };
}

/** Records which SAN set the leaf on disk was issued for, so it can be reused verbatim. */
interface LeafRecord {
  sans: string[];
  issuedAt: string;
}

const LEAF_RECORD = "leaf.json";
/** Reissue this long before expiry rather than handing out a cert about to go stale. */
const LEAF_RENEW_BEFORE_DAYS = 30;

async function readLeafRecord(): Promise<LeafRecord | null> {
  try {
    const parsed = (await Bun.file(join(caDir(), LEAF_RECORD)).json()) as LeafRecord;
    return Array.isArray(parsed?.sans) && typeof parsed?.issuedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True when the leaf already on disk covers exactly this SAN set and has enough life left.
 *
 * This is what keeps HTTPS stable: `issueLeaf` runs on every apply, and a fresh certificate
 * every time means fresh TLS material every time, which makes the helper tear down and rebind
 * its :443 listener — dropping every live HTTPS request and HMR socket — on each alias edit.
 */
async function reusableLeaf(sans: string[]): Promise<{ cert: string; key: string } | null> {
  if (!existsSync(leafCertPath()) || !existsSync(leafKeyPath())) return null;
  const record = await readLeafRecord();
  if (record === null) return null;
  if (record.sans.length !== sans.length || record.sans.some((san, i) => san !== sans[i])) return null;

  const ageDays = (Date.now() - Date.parse(record.issuedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > LEAF_DAYS - LEAF_RENEW_BEFORE_DAYS) return null;

  return { cert: await Bun.file(leafCertPath()).text(), key: await Bun.file(leafKeyPath()).text() };
}

/**
 * Issues one leaf certificate whose SANs cover every hostname handed in, plus loopback.
 * Writes it to `leafCertPath()` / `leafKeyPath()` (the helper reads them from there after a
 * restart) and returns the PEM strings for the caller to push straight into an ApplyRequest.
 *
 * The leaf on disk is reused unchanged when it already covers exactly this SAN set — see
 * `reusableLeaf`. Any change to the alias list issues a new one.
 */
export async function issueLeaf(hostnames: string[]): Promise<{ cert: string; key: string }> {
  const ca = await ensureCA();
  const dir = caDir();
  const sans = buildSans(hostnames);
  const reused = await reusableLeaf(sans);
  if (reused !== null) return reused;

  const certPath = leafCertPath();
  const keyPath = leafKeyPath();
  const configPath = join(dir, "leaf.cnf");
  const csrPath = join(dir, "leaf.csr");

  await writeFile(configPath, leafConfig(sans), { mode: 0o600 });
  try {
    await runOpenssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-config",
      configPath,
    ]);
    await runOpenssl([
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      ca.certPath,
      "-CAkey",
      ca.keyPath,
      "-CAcreateserial",
      "-CAserial",
      join(dir, "rootCA.srl"),
      "-out",
      certPath,
      "-days",
      String(LEAF_DAYS),
      "-sha256",
      // The extension block lives in the same config file the CSR was built from.
      "-extfile",
      configPath,
      "-extensions",
      LEAF_EXT_SECTION,
    ]);
    await chmod(keyPath, 0o600);
    await chmod(certPath, 0o644);
    // Written last: a record without a matching cert on disk would claim a reusable leaf.
    const record: LeafRecord = { sans, issuedAt: new Date().toISOString() };
    await writeFile(join(dir, LEAF_RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } finally {
    await rm(configPath, { force: true });
    await rm(csrPath, { force: true });
  }

  return {
    cert: await Bun.file(certPath).text(),
    key: await Bun.file(keyPath).text(),
  };
}


/** SAN entries the leaf currently on disk was issued for; empty when there is no leaf. */
export async function leafSans(): Promise<string[]> {
  if (!existsSync(leafCertPath())) return [];
  const record = await readLeafRecord();
  return record?.sans ?? [];
}

// ---------------------------------------------------------------------------
// Keychain trust
// ---------------------------------------------------------------------------

/** Which macOS keychain holds our CA. Two stores, two very different consequences. */
export type TrustStore = "system" | "login";

export interface CATrustState {
  /**
   * What a TLS client on this Mac actually concludes, from `security verify-cert` against
   * our exact certificate file — not from "a certificate with that name exists somewhere".
   */
  trusted: boolean;
  /** Every keychain that holds this exact certificate, by SHA-1. */
  stores: TrustStore[];
  /** Uppercase, colon-free SHA-1 of the CA on disk; null when there is no CA. */
  fingerprint: string | null;
}

/**
 * The user's login keychain. `LA_LOGIN_KEYCHAIN` exists so tests can point the probe at a
 * throwaway keychain; nothing in this repo may ever write to the real one without a click.
 */
export function loginKeychainPath(): string {
  return (
    process.env.LA_LOGIN_KEYCHAIN ??
    join(homedir(), "Library", "Keychains", "login.keychain-db")
  );
}

function keychainFor(store: TrustStore): string {
  return store === "system" ? SYSTEM_KEYCHAIN : loginKeychainPath();
}

async function spawnText(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** Uppercase hex SHA-1 of the CA on disk, the identity both keychains index it by. */
async function caFingerprint(): Promise<string | null> {
  if (!caExists()) return null;
  const { code, out } = await spawnText([
    OPENSSL,
    "x509",
    "-in",
    caCertPath(),
    "-noout",
    "-fingerprint",
    "-sha1",
  ]);
  if (code !== 0) return null;
  const hex = /Fingerprint\s*=\s*([0-9A-Fa-f:]+)/.exec(out)?.[1];
  return hex ? hex.replace(/:/g, "").toUpperCase() : null;
}

/**
 * True when *this exact certificate* is in that keychain.
 *
 * Matching on the common name alone is not good enough: a temp CA generated under
 * `LA_CONFIG_DIR` carries the same CN as the one the user trusted years ago, so a name
 * match would report a throwaway CA as trusted. `-Z` prints the SHA-1 of every hit.
 */
async function holdsCA(store: TrustStore, fingerprint: string): Promise<boolean> {
  const { code, out } = await spawnText([
    SECURITY,
    "find-certificate",
    "-a",
    "-c",
    CA_COMMON_NAME,
    "-Z",
    keychainFor(store),
  ]);
  if (code !== 0) return false;
  return out.toUpperCase().includes(fingerprint);
}

/**
 * Whether a TLS client on this Mac trusts our CA, and which keychain it came from.
 *
 * `verify-cert` is the honest answer — it runs the same evaluation Safari and `curl` do,
 * so an explicit "never trust" override reads as untrusted even though the certificate is
 * sitting right there in the keychain. The store list is reporting, not evidence.
 *
 * Read-only and never throws: the dashboard calls it on every status poll.
 */
export async function caTrustState(): Promise<CATrustState> {
  const empty: CATrustState = { trusted: false, stores: [], fingerprint: null };
  try {
    const fingerprint = await caFingerprint();
    if (fingerprint === null) return empty;

    const [system, login, verify] = await Promise.all([
      holdsCA("system", fingerprint),
      holdsCA("login", fingerprint),
      spawnText([SECURITY, "verify-cert", "-c", caCertPath(), "-p", "ssl"]),
    ]);

    const stores: TrustStore[] = [];
    if (system) stores.push("system");
    if (login) stores.push("login");
    return { trusted: verify.code === 0, stores, fingerprint };
  } catch {
    return empty;
  }
}

/**
 * True when a TLS client on this Mac trusts our CA. Signature unchanged from CORE_API.md;
 * `caTrustState()` is the one that says *where* the trust comes from.
 */
export async function isCATrusted(): Promise<boolean> {
  return (await caTrustState()).trusted;
}

/** The exact one-liner the dashboard shows for the user to copy, paste and run. */
export function trustCommand(): string {
  return `sudo security add-trusted-cert -d -r trustRoot -k ${SYSTEM_KEYCHAIN} "${caCertPath()}"`;
}

/**
 * The same thing scoped to the user: no sudo, no machine-wide change, and revocable from
 * Keychain Access. This is what onboarding runs, and it is why onboarding cannot do it
 * silently — macOS raises a password dialog for it.
 */
export function loginTrustCommand(): string {
  return `security add-trusted-cert -r trustRoot -k "${loginKeychainPath()}" "${caCertPath()}"`;
}

export interface TrustOutcome {
  ok: boolean;
  /** Where the certificate ended up, once the trust probe agrees. */
  state: CATrustState;
  error: string | null;
  /** True when `LA_TRUST_STUB` short-circuited the real command. */
  stubbed: boolean;
}

/**
 * Adds the CA to the **login** keychain as a trusted root.
 *
 * This raises a macOS authentication dialog on the user's screen, so it must only ever run
 * from an explicit click. `LA_TRUST_STUB` short-circuits it — `ok` pretends it succeeded,
 * anything else is reported as that failure message — and every test in this repo sets it.
 * Never call this from a test, a script or an agent without that variable set.
 */
export async function trustCAInLoginKeychain(): Promise<TrustOutcome> {
  if (!caExists()) {
    return {
      ok: false,
      state: { trusted: false, stores: [], fingerprint: null },
      error: "There is no local certificate authority to trust yet.",
      stubbed: false,
    };
  }

  const stub = process.env.LA_TRUST_STUB;
  if (stub !== undefined && stub !== "") {
    const ok = stub === "ok";
    return {
      ok,
      state: ok
        ? { trusted: true, stores: ["login"], fingerprint: await caFingerprint() }
        : await caTrustState(),
      error: ok ? null : stub,
      stubbed: true,
    };
  }

  const { code, err } = await spawnText([
    SECURITY,
    "add-trusted-cert",
    "-r",
    "trustRoot",
    "-k",
    loginKeychainPath(),
    caCertPath(),
  ]);

  const state = await caTrustState();
  if (code === 0) return { ok: true, state, error: null, stubbed: false };
  return {
    ok: false,
    state,
    // Exit 1 with empty stderr is what a cancelled password dialog looks like.
    error: err.trim() === "" ? "The authorisation dialog was cancelled." : err.trim(),
    stubbed: false,
  };
}
