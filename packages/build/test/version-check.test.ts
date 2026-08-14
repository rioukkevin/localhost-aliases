import { describe, expect, test } from "bun:test";
import { assertVersionsMatch, compareSemver, versionFromTag } from "../version-check.ts";

describe("versionFromTag", () => {
  test("strips the ref prefix and the v", () => {
    expect(versionFromTag("refs/tags/v2.0.0")).toBe("2.0.0");
    expect(versionFromTag("v2.0.0")).toBe("2.0.0");
    expect(versionFromTag("2.0.0")).toBe("2.0.0");
    expect(versionFromTag("refs/tags/v2.1.0-rc.1")).toBe("2.1.0-rc.1");
  });

  test("refuses anything that is not a release tag", () => {
    expect(() => versionFromTag("refs/heads/master")).toThrow(/not a release tag/);
    expect(() => versionFromTag("v2.0")).toThrow(/not a release tag/);
    expect(() => versionFromTag("latest")).toThrow(/not a release tag/);
    expect(() => versionFromTag("")).toThrow(/not a release tag/);
  });
});

describe("assertVersionsMatch", () => {
  test("returns the version everyone agrees on", () => {
    expect(
      assertVersionsMatch({ "git tag": "2.0.0", "package.json": "2.0.0", "Info.plist": "2.0.0" }),
    ).toBe("2.0.0");
  });

  test("skips sources that are not available yet", () => {
    expect(assertVersionsMatch({ "git tag": "2.0.0", "Info.plist": undefined })).toBe("2.0.0");
  });

  test("names every source when they disagree", () => {
    expect(() =>
      assertVersionsMatch({ "git tag": "2.1.0", "package.json": "2.0.0" }),
    ).toThrow(/version mismatch[\s\S]*git tag: 2\.1\.0[\s\S]*package\.json: 2\.0\.0/);
  });

  test("refuses to compare nothing", () => {
    expect(() => assertVersionsMatch({ "Info.plist": undefined })).toThrow(/no versions/);
  });
});

describe("compareSemver", () => {
  test("orders by major, minor then patch", () => {
    expect(compareSemver("2.0.0", "2.0.0")).toBe(0);
    expect(compareSemver("2.0.1", "2.0.0")).toBe(1);
    expect(compareSemver("2.0.0", "2.1.0")).toBe(-1);
    expect(compareSemver("10.0.0", "9.9.9")).toBe(1);
  });

  test("a release outranks its own prereleases", () => {
    expect(compareSemver("2.0.0", "2.0.0-rc.1")).toBe(1);
    expect(compareSemver("2.0.0-rc.1", "2.0.0-rc.2")).toBe(-1);
    expect(compareSemver("2.0.0-rc.2", "2.0.0-rc.10")).toBe(-1);
    expect(compareSemver("2.0.0-alpha", "2.0.0-beta")).toBe(-1);
    expect(compareSemver("2.0.0-rc", "2.0.0-rc.1")).toBe(-1);
  });

  test("ignores build metadata", () => {
    expect(compareSemver("2.0.0+abc", "2.0.0+def")).toBe(0);
  });

  test("throws on things that are not versions", () => {
    expect(() => compareSemver("2.0", "2.0.0")).toThrow(/not both semver/);
  });
});
