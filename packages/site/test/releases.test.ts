/**
 * The manifest client, with fetch stubbed. The point of this file is that every hostile or
 * absent input resolves to null/[] instead of throwing: the site renders that path today.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatDate,
  formatSize,
  getAllReleases,
  getLatestRelease,
  parseManifest,
  parseRelease,
  RELEASES_REVALIDATE_SECONDS,
} from "../lib/releases.ts";

const BASE = "https://example.public.blob.vercel-storage.com";
const MANIFEST_URL = `${BASE}/releases/latest.json`;

const realFetch = globalThis.fetch;
const realBaseUrl = process.env.NEXT_PUBLIC_BLOB_BASE_URL;

function release(version: string) {
  return {
    version,
    tag: `v${version}`,
    publishedAt: "2026-08-14T10:00:00.000Z",
    notes: `notes for ${version}`,
    minimumMacOS: "13.0",
    dmg: {
      url: `${BASE}/releases/LocalhostAliases-${version}.dmg`,
      filename: `LocalhostAliases-${version}.dmg`,
      size: 239075328,
      sha256: "abc123",
    },
  };
}

/** Records the calls so the revalidation contract can be asserted, not assumed. */
interface StubCall {
  url: string;
  init: unknown;
}
let calls: StubCall[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  process.env.NEXT_PUBLIC_BLOB_BASE_URL = BASE;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BLOB_BASE_URL;
  else process.env.NEXT_PUBLIC_BLOB_BASE_URL = realBaseUrl;
});

describe("getLatestRelease", () => {
  test("happy path", async () => {
    stubFetch(() => json({ ...release("2.0.0"), releases: [release("2.0.0"), release("1.9.0")] }));

    const latest = await getLatestRelease();
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe("2.0.0");
    expect(latest?.tag).toBe("v2.0.0");
    expect(latest?.minimumMacOS).toBe("13.0");
    expect(latest?.dmg.size).toBe(239075328);
    expect(latest?.dmg.sha256).toBe("abc123");
  });

  test("fetches the frozen manifest path with revalidation", async () => {
    stubFetch(() => json(release("2.0.0")));
    await getLatestRelease();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(MANIFEST_URL);
    expect(calls[0]?.init).toEqual({ next: { revalidate: RELEASES_REVALIDATE_SECONDS } });
  });

  test("a trailing slash on the base URL does not double up", async () => {
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = `${BASE}///`;
    stubFetch(() => json(release("2.0.0")));
    await getLatestRelease();
    expect(calls[0]?.url).toBe(MANIFEST_URL);
  });

  test("env var unset: no fetch at all, null", async () => {
    delete process.env.NEXT_PUBLIC_BLOB_BASE_URL;
    stubFetch(() => json(release("2.0.0")));

    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("env var empty or whitespace is treated as unset", async () => {
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = "   ";
    stubFetch(() => json(release("2.0.0")));

    expect(await getLatestRelease()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("404 — nothing published yet", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));

    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("500", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    expect(await getLatestRelease()).toBeNull();
  });

  test("network failure", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;
    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("malformed JSON", async () => {
    stubFetch(() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
    expect(await getLatestRelease()).toBeNull();
  });

  test("JSON that is not an object", async () => {
    stubFetch(() => json(["2.0.0"]));
    expect(await getLatestRelease()).toBeNull();

    stubFetch(() => json(null));
    expect(await getLatestRelease()).toBeNull();

    stubFetch(() => json("2.0.0"));
    expect(await getLatestRelease()).toBeNull();
  });

  test("missing fields", async () => {
    const cases: unknown[] = [
      { ...release("2.0.0"), version: undefined },
      { ...release("2.0.0"), tag: "" },
      { ...release("2.0.0"), publishedAt: undefined },
      { ...release("2.0.0"), dmg: undefined },
      { ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, url: undefined } },
      { ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, filename: undefined } },
      { ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, sha256: "" } },
      { ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, size: "239075328" } },
      { ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, size: Number.NaN } },
      { ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, size: -1 } },
      { ...release("2.0.0"), dmg: [] },
    ];

    for (const body of cases) {
      stubFetch(() => json(body));
      expect(await getLatestRelease()).toBeNull();
    }
  });

  test("notes and minimumMacOS are optional", async () => {
    const { notes: _notes, minimumMacOS: _min, ...rest } = release("2.0.0");
    stubFetch(() => json(rest));

    const latest = await getLatestRelease();
    expect(latest?.notes).toBe("");
    expect(latest?.minimumMacOS).toBeNull();
  });

  test("a non-http dmg url is rejected outright", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/hosts", "not a url"]) {
      stubFetch(() => json({ ...release("2.0.0"), dmg: { ...release("2.0.0").dmg, url } }));
      expect(await getLatestRelease()).toBeNull();
    }
  });
});

describe("getAllReleases", () => {
  test("newest first, latest folded in, duplicates dropped", async () => {
    stubFetch(() => json({ ...release("2.0.0"), releases: [release("2.0.0"), release("1.9.0"), release("1.8.0")] }));

    expect((await getAllReleases()).map((r) => r.version)).toEqual(["2.0.0", "1.9.0", "1.8.0"]);
  });

  test("a manifest that omits itself from its own history still lists itself", async () => {
    stubFetch(() => json({ ...release("2.0.0"), releases: [release("1.9.0")] }));
    expect((await getAllReleases()).map((r) => r.version)).toEqual(["2.0.0", "1.9.0"]);
  });

  test("no releases key at all", async () => {
    stubFetch(() => json(release("2.0.0")));
    expect((await getAllReleases()).map((r) => r.version)).toEqual(["2.0.0"]);
  });

  test("a rotten entry is dropped, the rest survive", async () => {
    stubFetch(() =>
      json({
        ...release("2.0.0"),
        releases: [release("1.9.0"), { version: "1.8.0" }, null, "1.7.0", release("1.6.0")],
      }),
    );

    expect((await getAllReleases()).map((r) => r.version)).toEqual(["2.0.0", "1.9.0", "1.6.0"]);
  });

  test("releases is not an array", async () => {
    stubFetch(() => json({ ...release("2.0.0"), releases: { "2.0.0": release("2.0.0") } }));
    expect((await getAllReleases()).map((r) => r.version)).toEqual(["2.0.0"]);
  });

  test("a broken top level still yields its valid history", async () => {
    stubFetch(() => json({ version: "2.0.0", releases: [release("1.9.0")] }));

    expect(await getLatestRelease()).toBeNull();
    expect((await getAllReleases()).map((r) => r.version)).toEqual(["1.9.0"]);
  });
});

describe("parsers are pure and total", () => {
  test("parseRelease rejects junk without throwing", () => {
    for (const value of [null, undefined, 0, "", [], {}, { dmg: {} }]) {
      expect(parseRelease(value)).toBeNull();
    }
  });

  test("parseManifest on junk", () => {
    expect(parseManifest(undefined)).toEqual({ latest: null, all: [] });
    expect(parseManifest({ releases: "nope" })).toEqual({ latest: null, all: [] });
  });
});

describe("formatting", () => {
  test("formatSize", () => {
    expect(formatSize(239075328)).toBe("239 MB");
    expect(formatSize(23907532)).toBe("23.9 MB");
    expect(formatSize(1_000_000)).toBe("1.0 MB");
    expect(formatSize(512_000)).toBe("512 kB");
    expect(formatSize(-1)).toBe("");
    expect(formatSize(Number.NaN)).toBe("");
  });

  test("formatDate is UTC and locale-free, so server and client agree", () => {
    expect(formatDate("2026-08-14T10:00:00.000Z")).toBe("14 August 2026");
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("1 January 2026");
  });

  test("formatDate passes an unparseable value through untouched", () => {
    expect(formatDate("whenever")).toBe("whenever");
  });
});
