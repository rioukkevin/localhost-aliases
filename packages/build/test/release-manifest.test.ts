import { describe, expect, test } from "bun:test";
import {
  historyFrom,
  manifestVersion,
  mergeManifest,
  parseManifest,
  toReleaseEntry,
  type ReleaseEntry,
  type ReleaseManifest,
} from "../release-manifest.ts";

function entry(version: string, overrides: Partial<ReleaseEntry> = {}): ReleaseEntry {
  return {
    version,
    tag: `v${version}`,
    publishedAt: `2026-0${version[0]}-01T00:00:00.000Z`,
    notes: `notes for ${version}`,
    minimumMacOS: "13.0",
    dmg: {
      url: `https://store.public.blob.vercel-storage.com/releases/LocalhostAliases-${version}.dmg`,
      filename: `LocalhostAliases-${version}.dmg`,
      size: 239075328,
      sha256: `sha-${version}`,
    },
    ...overrides,
  };
}

function manifest(top: ReleaseEntry, history: ReleaseEntry[]): ReleaseManifest {
  return { ...top, releases: [top, ...history] };
}

describe("parseManifest", () => {
  test("answers null instead of throwing on garbage", () => {
    expect(parseManifest("<!doctype html>not json")).toBeNull();
    expect(parseManifest("")).toBeNull();
  });

  test("parses valid JSON", () => {
    expect(parseManifest('{"version":"2.0.0"}')).toEqual({ version: "2.0.0" });
  });
});

describe("toReleaseEntry", () => {
  test("keeps an entry that has a version and a usable dmg", () => {
    expect(toReleaseEntry(entry("2.0.0"))).toEqual(entry("2.0.0"));
  });

  test("salvages an entry whose cosmetic fields are missing", () => {
    const salvaged = toReleaseEntry({ version: "1.9.0", dmg: entry("1.9.0").dmg });
    expect(salvaged).not.toBeNull();
    expect(salvaged?.tag).toBe("v1.9.0");
    expect(salvaged?.notes).toBe("");
  });

  test("rejects entries with no version or no dmg", () => {
    expect(toReleaseEntry({ dmg: entry("2.0.0").dmg })).toBeNull();
    expect(toReleaseEntry({ version: "2.0.0" })).toBeNull();
    expect(toReleaseEntry({ version: "2.0.0", dmg: { url: "u", filename: "f" } })).toBeNull();
    expect(toReleaseEntry("2.0.0")).toBeNull();
    expect(toReleaseEntry(null)).toBeNull();
  });

  test("never copies the nested history into an entry", () => {
    const salvaged = toReleaseEntry(manifest(entry("2.0.0"), [entry("1.0.0")]));
    expect(salvaged).not.toBeNull();
    expect(Object.keys(salvaged as object)).not.toContain("releases");
  });
});

describe("historyFrom", () => {
  test("is empty when there is no previous manifest", () => {
    expect(historyFrom(null)).toEqual([]);
    expect(historyFrom(undefined)).toEqual([]);
    expect(historyFrom("nonsense")).toEqual([]);
    expect(historyFrom([])).toEqual([]);
  });

  test("keeps the published order and does not duplicate the top-level release", () => {
    const previous = manifest(entry("2.1.0"), [entry("2.0.0"), entry("1.9.0")]);
    expect(historyFrom(previous).map((r) => r.version)).toEqual(["2.1.0", "2.0.0", "1.9.0"]);
  });

  test("recovers the top-level release when releases[] forgot it", () => {
    const previous = { ...entry("2.1.0"), releases: [entry("2.0.0")] };
    expect(historyFrom(previous).map((r) => r.version)).toEqual(["2.1.0", "2.0.0"]);
  });

  test("drops unusable entries but keeps the rest of the history", () => {
    const previous = {
      ...entry("2.1.0"),
      releases: [entry("2.0.0"), { version: "1.5.0" }, null, entry("1.0.0")],
    };
    expect(historyFrom(previous).map((r) => r.version)).toEqual(["2.1.0", "2.0.0", "1.0.0"]);
  });
});

describe("mergeManifest", () => {
  test("prepends and preserves everything that came before", () => {
    const previous = manifest(entry("2.0.0"), [entry("1.9.0")]);
    const merged = mergeManifest(entry("2.1.0"), previous);

    expect(merged.version).toBe("2.1.0");
    expect(merged.releases.map((r) => r.version)).toEqual(["2.1.0", "2.0.0", "1.9.0"]);
    // publishing v2.1 must not erase v2.0 from the changelog
    expect(merged.releases[1]).toEqual(entry("2.0.0"));
  });

  test("the first release stands alone", () => {
    const merged = mergeManifest(entry("2.0.0"), null);
    expect(merged.releases).toEqual([entry("2.0.0")]);
  });

  test("a corrupt previous manifest costs the history, not the release", () => {
    const merged = mergeManifest(entry("2.0.0"), parseManifest("}{ truncated"));
    expect(merged.releases.map((r) => r.version)).toEqual(["2.0.0"]);
  });

  test("re-publishing a version replaces its entry instead of duplicating it", () => {
    const previous = manifest(entry("2.0.0", { notes: "typo" }), [entry("1.9.0")]);
    const merged = mergeManifest(entry("2.0.0", { notes: "fixed" }), previous);

    expect(merged.releases.map((r) => r.version)).toEqual(["2.0.0", "1.9.0"]);
    expect(merged.releases[0]?.notes).toBe("fixed");
  });

  test("the top level is always releases[0]", () => {
    const merged = mergeManifest(entry("3.0.0"), manifest(entry("2.0.0"), []));
    const { releases, ...top } = merged;
    expect(releases[0]).toEqual(top);
  });
});

describe("manifestVersion", () => {
  test("reads the advertised version, or null", () => {
    expect(manifestVersion(manifest(entry("2.0.0"), []))).toBe("2.0.0");
    expect(manifestVersion({})).toBeNull();
    expect(manifestVersion(null)).toBeNull();
  });
});
