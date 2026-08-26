/**
 * These lock down the two things that make a certificate work in a browser rather than just
 * in openssl: it chains to our CA, and its lifetime is short enough that Apple accepts it.
 * A 10-year leaf verifies happily on the command line and then fails in Safari.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

let dir: string;
let certs: typeof import("../src/certs.ts");
let paths: typeof import("../src/paths.ts");

beforeEach(async () => {
  dir = mkdtempSync("/tmp/la-certs-");
  process.env.LA_CONFIG_DIR = dir;
  certs = await import("../src/certs.ts");
  paths = await import("../src/paths.ts");
});
afterEach(() => {
  delete process.env.LA_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the CA", () => {
  test("is created once and never replaced", async () => {
    const first = await certs.ensureCA();
    expect(first.created).toBe(true);
    const bytes = await Bun.file(first.certPath).text();

    const second = await certs.ensureCA();
    expect(second.created).toBe(false);
    // Byte-identical: the user has trusted this exact certificate.
    expect(await Bun.file(second.certPath).text()).toBe(bytes);
  });

  test("keeps its private key unreadable by anyone else", async () => {
    const { keyPath } = await certs.ensureCA();
    expect(statSync(keyPath).mode & 0o077).toBe(0);
  });
});

describe("the leaf", () => {
  test("chains to the CA and covers every hostname asked for", async () => {
    await certs.issueAliasCert(["shop.test", "api.shop.test", "docs.test"], ["127.0.0.2"]);
    expect(await certs.certHostnames()).toEqual(["api.shop.test", "docs.test", "shop.test"]);

    // The real question: does it verify against our CA?
    const verify = Bun.spawn(
      ["/usr/bin/openssl", "verify", "-CAfile", paths.caCertPath(), paths.aliasCertPath()],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await verify.exited).toBe(0);
  });

  test("lives under Apple's 398-day ceiling", async () => {
    await certs.issueAliasCert(["shop.test"]);
    const left = (await certs.certExpiresInMs())!;
    const days = left / 86_400_000;
    expect(days).toBeGreaterThan(390);
    expect(days).toBeLessThan(398);
  });

  test("is re-issued when the hostname set changes, and not when it has not", async () => {
    await certs.issueAliasCert(["shop.test"]);
    expect(await certs.certNeedsReissue(["shop.test"])).toBe(false);
    expect(await certs.certNeedsReissue(["shop.test", "new.test"])).toBe(true);
    expect(await certs.certNeedsReissue(["other.test"])).toBe(true);
  });

  test("is re-issued when it is close to expiring", async () => {
    await certs.issueAliasCert(["shop.test"]);
    const soon = Date.now() + 380 * 86_400_000; // inside the 30-day renewal window
    expect(await certs.certNeedsReissue(["shop.test"], soon)).toBe(true);
  });

  test("refuses to issue for no hostnames rather than making a useless cert", async () => {
    await expect(certs.issueAliasCert([])).rejects.toThrow(/no hostnames/);
  });

  test("leaves no scaffolding behind", async () => {
    await certs.issueAliasCert(["shop.test"]);
    expect(existsSync(join(paths.caDir(), "aliases.csr"))).toBe(false);
    expect(existsSync(join(paths.caDir(), "aliases.ext"))).toBe(false);
  });
});

describe("trust", () => {
  test("an untrusted CA reports untrusted rather than throwing", async () => {
    await certs.ensureCA();
    expect(await certs.isCATrusted()).toBe(false);
  });

  test("no CA at all is not trusted, and does not throw", async () => {
    expect(await certs.isCATrusted()).toBe(false);
  });

  test("the trust command names the real CA file", async () => {
    await certs.ensureCA();
    expect(certs.trustCommand()).toContain(paths.caCertPath());
    expect(certs.trustCommand()).toContain("login.keychain-db");
  });
});

describe("buildSans", () => {
  test("always includes loopback, dedupes, and sorts", () => {
    expect(certs.buildSans(["b.test", "a.test", "b.test"], ["127.0.0.3"])).toEqual([
      "DNS:a.test",
      "DNS:b.test",
      "IP:127.0.0.1",
      "IP:127.0.0.3",
    ]);
  });
});

/**
 * The renewal schedule, stated as tests rather than left implicit in two constants. A
 * certificate that expires under someone is the failure this whole mechanism exists to avoid.
 */
describe("the renewal schedule is annual, with slack", () => {
  test("renewal starts on day 367 — under a year, with a month spare", () => {
    expect(certs.RENEW_ON_DAY).toBe(367);
    expect(certs.RENEW_ON_DAY).toBeLessThan(365 + 7);
    // Slack matters: renewal only runs while the app is open.
    expect(certs.LEAF_DAYS - certs.RENEW_ON_DAY).toBeGreaterThanOrEqual(30);
  });

  test("a fresh certificate is left alone for most of the year", async () => {
    await certs.issueAliasCert(["shop.test"]);
    const day = (n: number) => Date.now() + n * 86_400_000;
    expect(await certs.certNeedsReissue(["shop.test"], day(1))).toBe(false);
    expect(await certs.certNeedsReissue(["shop.test"], day(200))).toBe(false);
    expect(await certs.certNeedsReissue(["shop.test"], day(360))).toBe(false);
  });

  test("and renewed once it enters the window, or after it has lapsed", async () => {
    await certs.issueAliasCert(["shop.test"]);
    const day = (n: number) => Date.now() + n * 86_400_000;
    expect(await certs.certNeedsReissue(["shop.test"], day(370))).toBe(true);
    // Already expired — the app was closed through the whole window. Still recoverable.
    expect(await certs.certNeedsReissue(["shop.test"], day(400))).toBe(true);
    expect(await certs.certNeedsReissue(["shop.test"], day(1000))).toBe(true);
  });

  test("renewing produces a genuinely different certificate, not the same bytes", async () => {
    await certs.issueAliasCert(["shop.test"]);
    const first = await Bun.file(paths.aliasCertPath()).text();
    await Bun.sleep(1100); // openssl's serial counter has one-second resolution
    await certs.issueAliasCert(["shop.test"]);
    const second = await Bun.file(paths.aliasCertPath()).text();
    expect(second).not.toBe(first);
    // Still ours, and still inside Apple's ceiling.
    const days = (await certs.certExpiresInMs())! / 86_400_000;
    expect(days).toBeGreaterThan(390);
    expect(days).toBeLessThan(398);
  }, 15000);
});
