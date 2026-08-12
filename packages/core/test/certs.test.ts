import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caCertPath, caDir, caKeyPath, leafCertPath, leafKeyPath } from "../src/paths.ts";
import {
  CA_COMMON_NAME,
  buildSans,
  caExists,
  caTrustState,
  ensureCA,
  issueLeaf,
  leafSans,
  loginKeychainPath,
  loginTrustCommand,
  trustCAInLoginKeychain,
  trustCommand,
} from "../src/certs.ts";

const OPENSSL = "/usr/bin/openssl";
const hasOpenssl = existsSync(OPENSSL);
/** Generating a 4096-bit CA plus a leaf is slow on a cold CPU. */
const SLOW = 120_000;

// ---------------------------------------------------------------------------
describe("buildSans", () => {
  const cases: Array<{ name: string; input: string[]; expected: string[] }> = [
    { name: "always covers loopback", input: [], expected: ["localhost", "127.0.0.1", "::1"] },
    {
      name: "keeps the given hostnames first, in order",
      input: ["b.local", "a.local"],
      expected: ["b.local", "a.local", "localhost", "127.0.0.1", "::1"],
    },
    {
      name: "dedupes the input",
      input: ["a.local", "a.local", "b.local"],
      expected: ["a.local", "b.local", "localhost", "127.0.0.1", "::1"],
    },
    {
      name: "does not repeat an implicit SAN the caller already asked for",
      input: ["localhost", "a.local", "::1", "127.0.0.1"],
      expected: ["localhost", "a.local", "::1", "127.0.0.1"],
    },
    {
      name: "trims and drops blanks",
      input: ["  a.local  ", "", "   "],
      expected: ["a.local", "localhost", "127.0.0.1", "::1"],
    },
  ];

  for (const c of cases) {
    test(c.name, () => expect(buildSans(c.input)).toEqual(c.expected));
  }

  test("is pure: the input array is untouched", () => {
    const input = ["a.local"];
    buildSans(input);
    expect(input).toEqual(["a.local"]);
  });
});

// ---------------------------------------------------------------------------
describe("trustCommand", () => {
  test("is a copyable sudo one-liner naming the System keychain and our CA file", () => {
    const cmd = trustCommand();
    expect(cmd.startsWith("sudo security add-trusted-cert ")).toBe(true);
    expect(cmd).toContain("-r trustRoot");
    expect(cmd).toContain("/Library/Keychains/System.keychain");
    expect(cmd).toContain(caCertPath());
    expect(cmd.includes("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("loginTrustCommand", () => {
  test("is the same thing scoped to the user: no sudo, login keychain", () => {
    const cmd = loginTrustCommand();
    expect(cmd.startsWith("security add-trusted-cert ")).toBe(true);
    expect(cmd).not.toContain("sudo");
    expect(cmd).not.toContain("/Library/Keychains/System.keychain");
    expect(cmd).toContain("-r trustRoot");
    expect(cmd).toContain(loginKeychainPath());
    expect(cmd).toContain(caCertPath());
  });

  test("LA_LOGIN_KEYCHAIN redirects the probe away from the real keychain", () => {
    const previous = process.env.LA_LOGIN_KEYCHAIN;
    process.env.LA_LOGIN_KEYCHAIN = "/tmp/nowhere.keychain-db";
    try {
      expect(loginKeychainPath()).toBe("/tmp/nowhere.keychain-db");
      expect(loginTrustCommand()).toContain("/tmp/nowhere.keychain-db");
    } finally {
      if (previous === undefined) delete process.env.LA_LOGIN_KEYCHAIN;
      else process.env.LA_LOGIN_KEYCHAIN = previous;
    }
  });
});

// ---------------------------------------------------------------------------
/** Reads a certificate back with openssl so assertions are on the real X.509, not our config. */
async function certText(path: string): Promise<string> {
  const proc = Bun.spawn([OPENSSL, "x509", "-in", path, "-noout", "-text"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

const suite = hasOpenssl ? describe : describe.skip;

suite("certificate authority (requires /usr/bin/openssl)", () => {
  let dir = "";
  const previous = process.env.LA_CONFIG_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "la-certs-"));
    process.env.LA_CONFIG_DIR = dir;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.LA_CONFIG_DIR;
    else process.env.LA_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("the suite is pointed at a temp config dir", () => {
    expect(process.env.LA_CONFIG_DIR).toBe(dir);
    expect(caDir().startsWith(dir)).toBe(true);
  });

  test("caExists is false before anything is generated", () => {
    expect(caExists()).toBe(false);
  });

  test(
    "ensureCA generates a 10-year root CA with the expected subject",
    async () => {
      const result = await ensureCA();
      expect(result.created).toBe(true);
      expect(result.certPath).toBe(caCertPath());
      expect(result.keyPath).toBe(caKeyPath());
      expect(caExists()).toBe(true);

      const text = await certText(caCertPath());
      expect(text).toContain(`CN=${CA_COMMON_NAME}`);
      expect(text).toContain("CA:TRUE");
      expect(text).toContain("Certificate Sign");

      const notBefore = /Not Before: (.+)/.exec(text)?.[1] ?? "";
      const notAfter = /Not After *: (.+)/.exec(text)?.[1] ?? "";
      const years =
        (Date.parse(`${notAfter} UTC`) - Date.parse(`${notBefore} UTC`)) /
        (365.25 * 24 * 3600 * 1000);
      expect(years).toBeGreaterThan(9.5);
      expect(years).toBeLessThan(10.5);
    },
    SLOW,
  );

  test("the private key is owner-only and the cert is world readable", async () => {
    expect((await stat(caKeyPath())).mode & 0o777).toBe(0o600);
    expect((await stat(caCertPath())).mode & 0o777).toBe(0o644);
  });

  test("the temporary openssl config is cleaned up", async () => {
    expect(await readdir(caDir())).not.toContain("ca.cnf");
  });

  test(
    "ensureCA is a no-op when the CA already exists (the user has trusted it)",
    async () => {
      const before = await Bun.file(caCertPath()).text();
      const beforeKey = await Bun.file(caKeyPath()).text();
      const result = await ensureCA();
      expect(result.created).toBe(false);
      expect(await Bun.file(caCertPath()).text()).toBe(before);
      expect(await Bun.file(caKeyPath()).text()).toBe(beforeKey);
    },
    SLOW,
  );

  test(
    "issueLeaf returns PEM material covering every hostname plus loopback",
    async () => {
      const { cert, key } = await issueLeaf(["a.local", "b.local", "a.local"]);
      expect(cert.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
      expect(key).toContain("PRIVATE KEY-----");

      const text = await certText(leafCertPath());
      expect(text).toContain("DNS:a.local");
      expect(text).toContain("DNS:b.local");
      expect(text).toContain("DNS:localhost");
      expect(text).toContain("IP Address:127.0.0.1");
      // LibreSSL prints ::1 fully expanded.
      expect(text).toContain("IP Address:0:0:0:0:0:0:0:1");
      expect(text).toContain("TLS Web Server Authentication");
      expect(text).toContain("CA:FALSE");
    },
    SLOW,
  );

  test("the leaf is written to the paths the helper reads, with a private key", async () => {
    expect(existsSync(leafCertPath())).toBe(true);
    expect((await stat(leafKeyPath())).mode & 0o777).toBe(0o600);
    expect((await stat(leafCertPath())).mode & 0o777).toBe(0o644);
  });

  test("the leaf chains to our CA", async () => {
    const proc = Bun.spawn(
      [OPENSSL, "verify", "-CAfile", caCertPath(), leafCertPath()],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await proc.exited).toBe(0);
  });

  test("temporary leaf files are cleaned up", async () => {
    const entries = await readdir(caDir());
    expect(entries).not.toContain("leaf.cnf");
    expect(entries).not.toContain("leaf.csr");
  });

  test(
    "issuing again reuses the same CA and covers the new hostnames",
    async () => {
      const caBefore = await Bun.file(caCertPath()).text();
      await issueLeaf(["c.local"]);
      expect(await Bun.file(caCertPath()).text()).toBe(caBefore);
      const text = await certText(leafCertPath());
      expect(text).toContain("DNS:c.local");
      expect(text).not.toContain("DNS:a.local");
    },
    SLOW,
  );

  test(
    "the same hostname list returns the identical leaf, so the helper never rebinds :443",
    async () => {
      const first = await issueLeaf(["c.local"]);
      const second = await issueLeaf(["c.local"]);
      expect(second.cert).toBe(first.cert);
      expect(second.key).toBe(first.key);
      // Order is part of the identity: buildSans preserves it, and so must the reuse check.
      const reordered = await issueLeaf(["c.local", "d.local"]);
      expect(reordered.cert).not.toBe(first.cert);
      expect(await certText(leafCertPath())).toContain("DNS:d.local");
    },
    SLOW,
  );

  test(
    "a leaf with no record of what it covers is reissued rather than trusted",
    async () => {
      const before = await Bun.file(leafCertPath()).text();
      await rm(join(caDir(), "leaf.json"), { force: true });
      const reissued = await issueLeaf(["c.local", "d.local"]);
      expect(reissued.cert).not.toBe(before);
    },
    SLOW,
  );

  test("leafSans reports what the leaf on disk actually covers", async () => {
    await issueLeaf(["e.local"]);
    expect(await leafSans()).toEqual(["e.local", "localhost", "127.0.0.1", "::1"]);
  });

  // -------------------------------------------------------------------------
  // Keychain trust. Read-only against the real keychains: nothing here adds,
  // removes or trusts anything, and the one command that would is stubbed.
  // Flat, not nested: bun:test runs a nested describe before its siblings, which
  // would put these ahead of the ensureCA that gives them a CA to look at.
  // -------------------------------------------------------------------------
  test(
    "a CA this Mac has never seen is untrusted, in no store, but has a fingerprint",
    async () => {
      const state = await caTrustState();
      expect(state.trusted).toBe(false);
      // Same common name as any CA the user may already have trusted: the probe
      // matches on SHA-1, so a name collision must not read as trust.
      expect(state.stores).toEqual([]);
      expect(state.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    },
    SLOW,
  );

  test("the trust command is never executed while LA_TRUST_STUB is set", async () => {
    const previous = process.env.LA_TRUST_STUB;
    try {
      process.env.LA_TRUST_STUB = "ok";
      const ok = await trustCAInLoginKeychain();
      expect(ok.stubbed).toBe(true);
      expect(ok.ok).toBe(true);
      expect(ok.state.stores).toEqual(["login"]);
      expect(ok.error).toBeNull();

      process.env.LA_TRUST_STUB = "User cancelled";
      const failed = await trustCAInLoginKeychain();
      expect(failed.stubbed).toBe(true);
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe("User cancelled");
      // A failed attempt reports the real state, not an optimistic one.
      expect(failed.state.trusted).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LA_TRUST_STUB;
      else process.env.LA_TRUST_STUB = previous;
    }
  });
});

// ---------------------------------------------------------------------------
describe("trusting a CA that does not exist", () => {
  const previousDir = process.env.LA_CONFIG_DIR;
  const previousStub = process.env.LA_TRUST_STUB;

  afterAll(() => {
    if (previousDir === undefined) delete process.env.LA_CONFIG_DIR;
    else process.env.LA_CONFIG_DIR = previousDir;
    if (previousStub === undefined) delete process.env.LA_TRUST_STUB;
    else process.env.LA_TRUST_STUB = previousStub;
  });

  test("refuses before it can spawn anything", async () => {
    process.env.LA_CONFIG_DIR = await mkdtemp(join(tmpdir(), "la-nocert-"));
    // Deliberately unset: the guard must fire before the stub is even consulted.
    delete process.env.LA_TRUST_STUB;
    const result = await trustCAInLoginKeychain();
    expect(result.ok).toBe(false);
    expect(result.stubbed).toBe(false);
    expect(result.error).toContain("no local certificate authority");
    expect(await caTrustState()).toEqual({ trusted: false, stores: [], fingerprint: null });
  });
});
