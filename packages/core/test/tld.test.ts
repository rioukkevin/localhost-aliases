/**
 * The TLD decision, end to end: what the default is, what is refused and why, and what
 * happens to a config that still names a refused suffix.
 *
 * No migration flow exists on purpose — the coercion below IS the whole story.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath } from "../src/paths.ts";
import { loadConfig, updateSettings } from "../src/store.ts";
import { buildDesiredState } from "../src/desired-state.ts";
import { assertValidTld } from "../src/validation.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_TLD,
  HSTS_PRELOADED_TLDS,
  SAFE_TLDS,
  ValidationError,
  blockedTldReason,
  isUsableTld,
  type Config,
} from "../src/types.ts";

let dir: string;
const previous = process.env.LA_CONFIG_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "la-tld-"));
  process.env.LA_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.LA_CONFIG_DIR;
  else process.env.LA_CONFIG_DIR = previous;
});

function messageFor(tld: unknown): string {
  try {
    assertValidTld(tld);
  } catch (err) {
    return (err as ValidationError).issues.map((i) => i.message).join(" ");
  }
  throw new Error(`expected assertValidTld(${JSON.stringify(tld)}) to throw`);
}

// ---------------------------------------------------------------------------

describe("the default", () => {
  test("is .test", () => {
    expect(DEFAULT_TLD).toBe("test");
    expect(DEFAULT_CONFIG.tld).toBe("test");
  });

  test("a fresh config on disk is seeded with it", async () => {
    expect((await loadConfig()).tld).toBe("test");
  });

  test("every offered option is itself usable", () => {
    for (const tld of SAFE_TLDS) expect(isUsableTld(tld)).toBe(true);
  });
});

describe("blocked suffixes", () => {
  test("local is refused for the mDNS delay, and says the number", () => {
    const message = messageFor("local");
    expect(message).toContain("mDNS");
    expect(message).toContain("5 seconds");
    expect(message).toContain(".test");
  });

  test("dev and app are refused for HSTS, not for mDNS", () => {
    for (const tld of ["dev", "app", "page", "foo", "zip"]) {
      const message = messageFor(tld);
      expect(message).toContain("HSTS");
      expect(message).toContain("https");
      expect(message).not.toContain("mDNS");
    }
  });

  test("localhost is refused because macOS answers it itself, ignoring /etc/hosts", () => {
    const message = messageFor("localhost");
    expect(message).toContain("127.0.0.1");
    expect(message).not.toContain("HSTS");
    expect(message).not.toContain("mDNS");
  });

  test("the three reasons are three different sentences", () => {
    const messages = new Set([messageFor("local"), messageFor("dev"), messageFor("localhost")]);
    expect(messages.size).toBe(3);
  });

  test("every HSTS-preloaded TLD is refused", () => {
    for (const tld of HSTS_PRELOADED_TLDS) expect(blockedTldReason(tld)).not.toBeNull();
  });

  test("the LAST label decides, so a multi-label suffix cannot smuggle one in", () => {
    expect(blockedTldReason("my.local")).toContain("mDNS");
    expect(blockedTldReason("team.dev")).toContain("HSTS");
    expect(blockedTldReason("home.arpa")).toBeNull();
  });

  test("case and whitespace do not get past it", () => {
    expect(() => assertValidTld(" LOCAL ")).toThrow(ValidationError);
    expect(() => assertValidTld("Dev")).toThrow(ValidationError);
  });

  test("a blocked suffix is refused by the store too, not only by the validator", async () => {
    await loadConfig();
    await expect(updateSettings({ tld: "local" })).rejects.toBeInstanceOf(ValidationError);
    expect((await loadConfig()).tld).toBe("test");
  });
});

describe("sensible suffixes still pass", () => {
  test.each(["test", "internal", "lan", "home.arpa", "example", "dev-box"])("accepts %s", (tld) => {
    expect(blockedTldReason(tld)).toBeNull();
    expect(() => assertValidTld(tld)).not.toThrow();
  });

  test("a non-default one can be saved", async () => {
    await loadConfig();
    expect((await updateSettings({ tld: "internal" })).tld).toBe("internal");
  });
});

describe("a config on disk that still says local", () => {
  const STORED = {
    version: 2,
    tld: "local",
    dashboardPort: 7788,
    https: false,
    autoApply: true,
    aliases: [
      {
        id: "reserved-1",
        name: "index",
        port: 7788,
        ip: "127.0.0.2",
        projectPath: null,
        description: null,
        enabled: true,
        reserved: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "shop-1",
        name: "shop",
        port: 3000,
        ip: "127.0.0.7",
        projectPath: "/Users/dev/shop",
        description: "the shop",
        enabled: true,
        reserved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  async function seedStored(): Promise<void> {
    await writeFile(configPath(), JSON.stringify(STORED));
  }

  test("loads as .test without throwing, and says so exactly once", async () => {
    await seedStored();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await loadConfig();
      const second = await loadConfig();
      const third = await loadConfig();

      expect(first.tld).toBe("test");
      expect(second.tld).toBe("test");
      expect(third.tld).toBe("test");

      // Once, because the coerced value is written straight back to disk.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("local");
      expect(String(warn.mock.calls[0]?.[0])).toContain("5 seconds");
    } finally {
      warn.mockRestore();
    }
  });

  test("the repaired file on disk no longer says local", async () => {
    await seedStored();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadConfig();
    } finally {
      warn.mockRestore();
    }
    const onDisk = JSON.parse(await readFile(configPath(), "utf8")) as Config;
    expect(onDisk.tld).toBe("test");
  });

  test("aliases keep their names, ports and loopback IPs across the coercion", async () => {
    await seedStored();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let config: Config;
    try {
      config = await loadConfig();
    } finally {
      warn.mockRestore();
    }

    expect(config.aliases.map((a) => [a.name, a.ip, a.port])).toEqual([
      ["index", "127.0.0.2", 7788],
      ["shop", "127.0.0.7", 3000],
    ]);
    expect(config.aliases[1]!.id).toBe("shop-1");
    expect(config.aliases[1]!.projectPath).toBe("/Users/dev/shop");
  });

  test("buildDesiredState then emits .test hostnames against the same IPs", async () => {
    await seedStored();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let config: Config;
    try {
      config = await loadConfig();
    } finally {
      warn.mockRestore();
    }

    const desired = buildDesiredState(config);
    expect(desired.hosts).toEqual([
      { ip: "127.0.0.2", hostname: "index.test" },
      { ip: "127.0.0.7", hostname: "shop.test" },
    ]);
    expect(desired.routes.map((r) => r.hostname)).toEqual(["index.test", "shop.test"]);
    expect(desired.loopbackIps).toEqual(["127.0.0.2", "127.0.0.7"]);
    expect(desired.hosts.some((h) => h.hostname.endsWith(".local"))).toBe(false);
  });
});
