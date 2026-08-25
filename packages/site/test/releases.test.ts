/**
 * The GitHub release client, with `fetch` stubbed.
 *
 * The point of this file is that every absent or hostile answer resolves to `null` / `[]`
 * instead of throwing, because the site takes that path TODAY: the repository has no tags and
 * no releases, and unauthenticated the API answers 404 for both endpoints. The happy path is
 * tested too, but it is the one state the site has never actually been in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatDate,
  formatSize,
  getAllReleases,
  getLatestRelease,
  githubHeaders,
  MAX_NOTES_LENGTH,
  parseDmgAsset,
  parseRelease,
  parseReleaseList,
  parseSha256,
  RELEASES_PAGE_SIZE,
  RELEASES_REVALIDATE_SECONDS,
  versionFromTag,
} from "../lib/releases.ts";

const LATEST_URL = "https://api.github.com/repos/rioukkevin/localhost-aliases/releases/latest";
const LIST_URL = `https://api.github.com/repos/rioukkevin/localhost-aliases/releases?per_page=${RELEASES_PAGE_SIZE}`;
const SHA = "9f2c1b0a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";

const realFetch = globalThis.fetch;
const realToken = process.env.GITHUB_TOKEN;
const realBase = process.env.GITHUB_API_BASE_URL;

/** A release exactly as the GitHub REST API shapes one. */
function apiRelease(version: string, overrides: Record<string, unknown> = {}) {
  const filename = `LocalhostAliases-${version}.dmg`;
  return {
    id: 1,
    tag_name: `v${version}`,
    name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-08-14T10:00:00Z",
    html_url: `https://github.com/rioukkevin/localhost-aliases/releases/tag/v${version}`,
    body: `### Added\n\n- A thing\n\n---\n\n\`\`\`\nsha256  ${SHA}\nsize    239075328 bytes\n\`\`\`\n`,
    assets: [
      {
        name: filename,
        size: 239075328,
        content_type: "application/x-apple-diskimage",
        browser_download_url: `https://github.com/rioukkevin/localhost-aliases/releases/download/v${version}/${filename}`,
      },
    ],
    ...overrides,
  };
}

interface StubCall {
  url: string;
  init: RequestInit | undefined;
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

/** How GitHub answers when the hourly budget is gone. */
function rateLimited(): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }), {
    status: 403,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
  });
}

beforeEach(() => {
  calls = [];
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_API_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = realToken;
  if (realBase === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = realBase;
});

describe("the request itself", () => {
  test("hits the documented endpoints with revalidation and the GitHub headers", async () => {
    stubFetch(() => json(apiRelease("2.0.0")));
    await getLatestRelease();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LATEST_URL);
    const init = calls[0]?.init as { next?: unknown; headers?: Record<string, string> };
    expect(init.next).toEqual({ revalidate: RELEASES_REVALIDATE_SECONDS });
    expect(init.headers?.accept).toBe("application/vnd.github+json");
    expect(init.headers?.["x-github-api-version"]).toBe("2022-11-28");
    // GitHub rejects a request with no User-Agent outright.
    expect(init.headers?.["user-agent"]).toBeTruthy();
  });

  test("the list endpoint asks for one page", async () => {
    stubFetch(() => json([apiRelease("2.0.0")]));
    await getAllReleases();
    expect(calls[0]?.url).toBe(LIST_URL);
  });

  test("no GITHUB_TOKEN: no Authorization header at all", () => {
    expect(githubHeaders().authorization).toBeUndefined();
  });

  test("GITHUB_TOKEN is sent as a bearer", async () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    stubFetch(() => json(apiRelease("2.0.0")));
    await getLatestRelease();

    const init = calls[0]?.init as { headers?: Record<string, string> };
    expect(init.headers?.authorization).toBe("Bearer ghp_example");
  });

  test("a blank GITHUB_TOKEN is treated as absent, not sent as `Bearer `", () => {
    process.env.GITHUB_TOKEN = "   ";
    expect(githubHeaders().authorization).toBeUndefined();
  });

  test("GITHUB_API_BASE_URL redirects the client at a fixture, trailing slashes and all", async () => {
    process.env.GITHUB_API_BASE_URL = "http://127.0.0.1:8123//";
    stubFetch(() => json(apiRelease("2.0.0")));
    await getLatestRelease();

    expect(calls[0]?.url).toBe("http://127.0.0.1:8123/repos/rioukkevin/localhost-aliases/releases/latest");
  });
});

describe("no releases — today's real state", () => {
  test("404 from both endpoints", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("an empty list is not an error", async () => {
    stubFetch(() => json([]));
    expect(await getAllReleases()).toEqual([]);
  });
});

describe("the API says no", () => {
  test("403 rate limited", async () => {
    stubFetch(() => rateLimited());
    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("429", async () => {
    stubFetch(() => new Response("slow down", { status: 429 }));
    expect(await getLatestRelease()).toBeNull();
  });

  test("500", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("the network is gone", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("a body that never resolves as JSON", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      })) as unknown as typeof fetch;

    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });
});

describe("malformed payloads", () => {
  test("malformed JSON", async () => {
    stubFetch(() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
    expect(await getLatestRelease()).toBeNull();
    expect(await getAllReleases()).toEqual([]);
  });

  test("JSON of the wrong shape", async () => {
    for (const body of [null, "v2.0.0", 42, [], {}, { tag_name: 7 }]) {
      stubFetch(() => json(body));
      expect(await getLatestRelease()).toBeNull();
    }
  });

  test("an object where a list was promised", async () => {
    stubFetch(() => json({ releases: [apiRelease("2.0.0")] }));
    expect(await getAllReleases()).toEqual([]);
  });

  test("a rotten entry is dropped and the rest survive", async () => {
    stubFetch(() => json([apiRelease("2.0.0"), null, "v1.9.0", { tag_name: "" }, apiRelease("1.8.0")]));
    expect((await getAllReleases()).map((r) => r.tag)).toEqual(["v2.0.0", "v1.8.0"]);
  });

  test("a hostile tag is not rendered or pasted into a URL", () => {
    for (const tag of ["v1 <script>", "../../etc/passwd", "v".repeat(80), "  ", 12]) {
      expect(parseRelease({ ...apiRelease("2.0.0"), tag_name: tag })).toBeNull();
    }
  });

  test("a body longer than the cap is truncated rather than rendered whole", () => {
    const release = parseRelease({ ...apiRelease("2.0.0"), body: "x".repeat(MAX_NOTES_LENGTH + 5_000) });
    expect(release?.notes).toHaveLength(MAX_NOTES_LENGTH);
  });

  test("a non-string body is empty notes, not a crash", () => {
    expect(parseRelease({ ...apiRelease("2.0.0"), body: null })?.notes).toBe("");
    expect(parseRelease({ ...apiRelease("2.0.0"), body: { text: "hi" } })?.notes).toBe("");
  });

  test("a missing published_at is empty, and formats to empty", () => {
    const release = parseRelease({ ...apiRelease("2.0.0"), published_at: null });
    expect(release?.publishedAt).toBe("");
    expect(formatDate(release?.publishedAt ?? "x")).toBe("");
  });

  test("a non-http html_url falls back to the canonical release page", () => {
    const release = parseRelease({ ...apiRelease("2.0.0"), html_url: "javascript:alert(1)" });
    expect(release?.htmlUrl).toBe("https://github.com/rioukkevin/localhost-aliases/releases/tag/v2.0.0");
  });
});

describe("a release with no .dmg attached", () => {
  test("no assets at all: the release is still real, the download is not", async () => {
    stubFetch(() => json(apiRelease("2.0.0", { assets: [] })));

    const latest = await getLatestRelease();
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe("2.0.0");
    expect(latest?.dmg).toBeNull();
  });

  test("assets that are not a disk image are ignored", () => {
    const assets = [
      { name: "LocalhostAliases-2.0.0.dmg.sha256", size: 100, browser_download_url: "https://example.com/x.sha256" },
      { name: "source.tar.gz", size: 100, browser_download_url: "https://example.com/s.tar.gz" },
    ];
    expect(parseDmgAsset(assets, null)).toBeNull();
  });

  test("an asset with a non-http url is refused outright", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/hosts", "not a url", 5]) {
      const assets = [{ name: "a.dmg", size: 10, browser_download_url: url }];
      expect(parseDmgAsset(assets, null)).toBeNull();
    }
  });

  test("an asset with an unusable size is skipped, and a later good one still wins", () => {
    const bad = { name: "a.dmg", size: "239075328", browser_download_url: "https://example.com/a.dmg" };
    const good = { name: "b.dmg", size: 10, browser_download_url: "https://example.com/b.dmg" };
    expect(parseDmgAsset([bad], null)).toBeNull();
    expect(parseDmgAsset([bad, good], null)?.filename).toBe("b.dmg");
    expect(parseDmgAsset([{ ...good, size: Number.NaN }], null)).toBeNull();
    expect(parseDmgAsset([{ ...good, size: -1 }], null)).toBeNull();
  });

  test("assets that are not an array, or not objects", () => {
    expect(parseDmgAsset(undefined, null)).toBeNull();
    expect(parseDmgAsset({ "0": { name: "a.dmg" } }, null)).toBeNull();
    expect(parseDmgAsset([null, "a.dmg", 3], null)).toBeNull();
  });

  test("the extension check is case-insensitive", () => {
    const assets = [{ name: "LocalhostAliases-2.0.0.DMG", size: 5, browser_download_url: "https://e.com/a.DMG" }];
    expect(parseDmgAsset(assets, null)?.filename).toBe("LocalhostAliases-2.0.0.DMG");
  });
});

describe("the sha256 in the release body", () => {
  test("the fenced, labelled form the publish step writes", () => {
    expect(parseSha256(`\`\`\`\nsha256  ${SHA}\nsize    1 bytes\n\`\`\``)).toBe(SHA);
  });

  test("the shasum -c form", () => {
    expect(parseSha256(`${SHA}  LocalhostAliases-2.0.0.dmg`)).toBe(SHA);
  });

  test("uppercase is normalised", () => {
    expect(parseSha256(`SHA-256: ${SHA.toUpperCase()}`)).toBe(SHA);
  });

  test("absence is unknown, never a failure", async () => {
    stubFetch(() => json(apiRelease("2.0.0", { body: "### Added\n\n- A thing with no checksum in it\n" })));

    const latest = await getLatestRelease();
    expect(latest?.dmg).not.toBeNull();
    expect(latest?.dmg?.sha256).toBeNull();
    expect(latest?.dmg?.url).toContain("LocalhostAliases-2.0.0.dmg");
  });

  test("something that only looks like a checksum is not one", () => {
    expect(parseSha256("commit 0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4")).toBeNull(); // 40 hex, a sha1
    expect(parseSha256("sha256 not-a-hash")).toBeNull();
    expect(parseSha256("")).toBeNull();
  });
});

describe("drafts and prereleases", () => {
  test("a draft is never a release, whatever the endpoint says", () => {
    expect(parseRelease(apiRelease("2.0.0", { draft: true }))).toBeNull();
    expect(parseReleaseList([apiRelease("2.0.0", { draft: true }), apiRelease("1.9.0")]).map((r) => r.tag)).toEqual([
      "v1.9.0",
    ]);
  });

  test("a prerelease is kept, and says so", () => {
    expect(parseRelease(apiRelease("2.1.0-rc.1", { prerelease: true }))?.prerelease).toBe(true);
    expect(parseRelease(apiRelease("2.0.0"))?.prerelease).toBe(false);
  });

  test("the same tag twice collapses to one entry", () => {
    expect(parseReleaseList([apiRelease("2.0.0"), apiRelease("2.0.0")]).map((r) => r.tag)).toEqual(["v2.0.0"]);
  });
});

describe("a good release", () => {
  test("every field the pages render", async () => {
    stubFetch(() => json(apiRelease("2.0.0")));

    const latest = await getLatestRelease();
    expect(latest).not.toBeNull();
    expect(latest?.tag).toBe("v2.0.0");
    expect(latest?.version).toBe("2.0.0");
    expect(latest?.publishedAt).toBe("2026-08-14T10:00:00Z");
    expect(latest?.prerelease).toBe(false);
    expect(latest?.htmlUrl).toBe("https://github.com/rioukkevin/localhost-aliases/releases/tag/v2.0.0");
    expect(latest?.notes).toContain("### Added");
    expect(latest?.minimumMacOS).toBe("13.0");
    expect(latest?.dmg?.filename).toBe("LocalhostAliases-2.0.0.dmg");
    expect(latest?.dmg?.size).toBe(239075328);
    expect(latest?.dmg?.sha256).toBe(SHA);
    expect(latest?.dmg?.url).toBe(
      "https://github.com/rioukkevin/localhost-aliases/releases/download/v2.0.0/LocalhostAliases-2.0.0.dmg",
    );
  });

  test("the changelog list keeps the API's order", async () => {
    stubFetch(() => json([apiRelease("2.0.0"), apiRelease("1.9.0"), apiRelease("1.8.0")]));
    expect((await getAllReleases()).map((r) => r.version)).toEqual(["2.0.0", "1.9.0", "1.8.0"]);
  });

  test("versionFromTag only strips a leading v before a digit", () => {
    expect(versionFromTag("v2.0.0")).toBe("2.0.0");
    expect(versionFromTag("2.0.0")).toBe("2.0.0");
    expect(versionFromTag("ventura-build")).toBe("ventura-build");
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
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("1 January 2026");
  });

  test("formatDate passes an unparseable value through, and empty stays empty", () => {
    expect(formatDate("whenever")).toBe("whenever");
    expect(formatDate("")).toBe("");
  });
});
