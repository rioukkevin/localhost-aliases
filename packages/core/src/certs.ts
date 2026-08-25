/**
 * The local certificate authority.
 *
 * Browsers only show a padlock for a certificate that chains to a root they trust. There is
 * no way around that from inside the app: the user must add our root to their keychain once,
 * and macOS asks for their password when they do. Everything else here — generating the CA,
 * issuing the leaf, renewing it — happens without asking.
 *
 * Two rules shape this file:
 *
 *  1. **Never regenerate a CA that exists.** The user has trusted it. Replacing it silently
 *     breaks every alias and leaves an orphaned trusted root in their keychain. `ensureCA` is
 *     therefore a no-op when the files are already there, and says so in its result.
 *  2. **The leaf lives 397 days.** Apple rejects TLS server certificates valid for more than
 *     398 days, and Safari enforces this for privately-issued certificates too — a 10-year
 *     leaf looks fine in `openssl` and then fails in the browser with an error that does not
 *     mention the lifetime. We re-issue automatically well before expiry.
 *
 * Shells out to /usr/bin/openssl, which ships with macOS. Nothing here needs privileges: the
 * CA lives in the user's own config directory. Trusting it is the only step that does.
 */
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aliasCertPath,
  aliasKeyPath,
  caCertPath,
  caDir,
  caKeyPath,
} from "./paths.ts";

const OPENSSL = "/usr/bin/openssl";

/** The CA's subject. The uninstall matches on this to remove it from the keychain. */
export const CA_COMMON_NAME = "Localhost Aliases Local CA";

/** Apple rejects TLS server certs valid longer than 398 days. Stay under it. */
export const LEAF_DAYS = 397;

/** Re-issue once the leaf has less than this left, so it never expires while in use. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Run openssl, returning stderr on failure so a caller can say what actually went wrong. */
async function openssl(args: string[], stdin?: string): Promise<{ ok: boolean; error: string }> {
  const proc = Bun.spawn([OPENSSL, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { ok: code === 0, error: error.trim() };
}

/** True when both halves of the CA are on disk. One without the other is not a CA. */
export async function caExists(): Promise<boolean> {
  return (await exists(caCertPath())) && (await exists(caKeyPath()));
}

/**
 * Generate the CA if it is missing. Never touches an existing one — see rule 1 above.
 * `created` tells the caller whether the user still needs to trust it.
 */
export async function ensureCA(): Promise<{ created: boolean; certPath: string; keyPath: string }> {
  const certPath = caCertPath();
  const keyPath = caKeyPath();
  if (await caExists()) return { created: false, certPath, keyPath };

  await mkdir(caDir(), { recursive: true });
  // 0700: the CA key is the whole ballgame. Anyone who reads it can impersonate any site
  // this machine trusts, so it never leaves the user's own directory.
  await chmod(caDir(), 0o700).catch(() => {});

  const result = await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-sha256",
    "-days", "3650",
    "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-subj", `/CN=${CA_COMMON_NAME}`,
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  if (!result.ok) throw new Error(`could not create the local CA: ${result.error}`);

  await chmod(keyPath, 0o600).catch(() => {});
  return { created: true, certPath, keyPath };
}

/** Every SAN the leaf should carry: the alias hostnames, plus loopback for direct hits. */
export function buildSans(hostnames: readonly string[], ips: readonly string[] = []): string[] {
  const dns = [...new Set(hostnames.filter((h) => typeof h === "string" && h.trim() !== ""))].sort();
  const addr = [...new Set(["127.0.0.1", ...ips.filter((i) => typeof i === "string" && i !== "")])].sort();
  return [...dns.map((h) => `DNS:${h}`), ...addr.map((i) => `IP:${i}`)];
}

/** The SAN hostnames currently baked into the leaf, or [] when there is no readable leaf. */
export async function certHostnames(): Promise<string[]> {
  if (!(await exists(aliasCertPath()))) return [];
  const proc = Bun.spawn([OPENSSL, "x509", "-in", aliasCertPath(), "-noout", "-text"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const found = [...text.matchAll(/DNS:([^\s,]+)/g)].map((m) => m[1] as string);
  return [...new Set(found)].sort();
}

/** Milliseconds until the leaf expires. Negative when it already has, null when unreadable. */
export async function certExpiresInMs(now: number = Date.now()): Promise<number | null> {
  if (!(await exists(aliasCertPath()))) return null;
  const proc = Bun.spawn([OPENSSL, "x509", "-in", aliasCertPath(), "-noout", "-enddate"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const match = text.match(/notAfter=(.+)/);
  if (!match?.[1]) return null;
  const at = Date.parse(match[1].trim());
  return Number.isNaN(at) ? null : at - now;
}

/**
 * Whether the leaf has to be rebuilt: it is missing, it no longer covers exactly this set of
 * hostnames, or it is close enough to expiry that it would lapse while someone is using it.
 */
export async function certNeedsReissue(
  hostnames: readonly string[],
  now: number = Date.now(),
): Promise<boolean> {
  if (!(await exists(aliasCertPath())) || !(await exists(aliasKeyPath()))) return true;

  const want = [...new Set(hostnames)].sort();
  const have = await certHostnames();
  if (want.length !== have.length || want.some((h, i) => h !== have[i])) return true;

  const left = await certExpiresInMs(now);
  return left === null || left < RENEW_BEFORE_MS;
}

/**
 * Issue the leaf covering every alias hostname. Overwrites the previous leaf — that is the
 * point, and unlike the CA it is safe: nothing has trusted the leaf itself.
 */
export async function issueAliasCert(
  hostnames: readonly string[],
  ips: readonly string[] = [],
): Promise<{ certPath: string; keyPath: string; hostnames: string[] }> {
  const dns = [...new Set(hostnames.filter((h) => typeof h === "string" && h.trim() !== ""))].sort();
  if (dns.length === 0) throw new Error("cannot issue a certificate for no hostnames");

  await ensureCA();
  const dir = caDir();
  const keyPath = aliasKeyPath();
  const certPath = aliasCertPath();
  const csr = join(dir, "aliases.csr");
  const ext = join(dir, "aliases.ext");

  await writeFile(
    ext,
    [
      `subjectAltName=${buildSans(dns, ips).join(",")}`,
      "extendedKeyUsage=serverAuth",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "",
    ].join("\n"),
    "utf8",
  );

  const req = await openssl([
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", csr,
    // The CN is legacy — browsers read SANs — but an empty subject upsets some tooling.
    "-subj", `/CN=${dns[0]}`,
  ]);
  if (!req.ok) throw new Error(`could not create the certificate request: ${req.error}`);

  const sign = await openssl([
    "x509", "-req",
    "-in", csr,
    "-CA", caCertPath(),
    "-CAkey", caKeyPath(),
    "-CAcreateserial",
    "-out", certPath,
    "-days", String(LEAF_DAYS),
    "-sha256",
    "-extfile", ext,
  ]);
  if (!sign.ok) throw new Error(`could not sign the certificate: ${sign.error}`);

  await chmod(keyPath, 0o600).catch(() => {});
  // The CSR and extension file are scaffolding; leaving them invites someone to edit one and
  // wonder why nothing changed.
  await rm(csr, { force: true }).catch(() => {});
  await rm(ext, { force: true }).catch(() => {});

  return { certPath, keyPath, hostnames: dns };
}

/**
 * Is our CA trusted for TLS in the user's login keychain?
 *
 * `security verify-cert` is the honest question — "find-certificate" only proves the file was
 * imported, not that the user granted it trust, and those are different states with the same
 * appearance. Never throws: an unreadable keychain is "not trusted", not a crash.
 */
export async function isCATrusted(): Promise<boolean> {
  if (!(await exists(caCertPath()))) return false;
  const proc = Bun.spawn(
    ["/usr/bin/security", "verify-cert", "-c", caCertPath(), "-p", "ssl"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0;
}

/**
 * The command that grants trust. macOS shows its own password dialog when this runs, which is
 * why it is a user action and not something the app does on its own.
 */
export function trustCommand(): string {
  return [
    "security add-trusted-cert",
    "-k ~/Library/Keychains/login.keychain-db",
    "-p ssl",
    `"${caCertPath()}"`,
  ].join(" ");
}
