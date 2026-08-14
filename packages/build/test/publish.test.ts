import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobClient } from "../blob-upload.ts";
import {
  MANIFEST_PATH,
  dmgFilename,
  dmgPathname,
  hashFile,
  publish,
  type PublishInput,
} from "../publish.ts";
import type { ReleaseEntry, ReleaseManifest } from "../release-manifest.ts";

const STORE = "https://store.public.blob.vercel-storage.com";

interface Recorder extends BlobClient {
  readonly files: { pathname: string; filePath: string; contentType: string }[];
  readonly jsons: { pathname: string; value: unknown; maxAgeSeconds: number }[];
}

/** A BlobClient that never touches the network; `existing` is what the store already holds. */
function fakeBlob(existing: string | null): Recorder {
  const files: Recorder["files"] = [];
  const jsons: Recorder["jsons"] = [];
  return {
    files,
    jsons,
    async readText(pathname) {
      expect(pathname).toBe(MANIFEST_PATH);
      return existing;
    },
    async putFile(pathname, filePath, contentType) {
      files.push({ pathname, filePath, contentType });
      return { url: `${STORE}/${pathname}`, pathname };
    },
    async putJson(pathname, value, maxAgeSeconds) {
      jsons.push({ pathname, value, maxAgeSeconds });
      return { url: `${STORE}/${pathname}`, pathname };
    },
  };
}

function input(version: string, overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    version,
    tag: `v${version}`,
    notes: `## ${version}\n\n- something`,
    minimumMacOS: "13.0",
    dmgPath: `dist/${dmgFilename(version)}`,
    filename: dmgFilename(version),
    size: 239075328,
    sha256: "abc123",
    publishedAt: "2026-08-14T10:00:00.000Z",
    ...overrides,
  };
}

function published(version: string, history: string[] = []): string {
  const entry = (v: string): ReleaseEntry => ({
    version: v,
    tag: `v${v}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    notes: `notes ${v}`,
    minimumMacOS: "13.0",
    dmg: {
      url: `${STORE}/releases/${dmgFilename(v)}`,
      filename: dmgFilename(v),
      size: 1,
      sha256: `sha-${v}`,
    },
  });
  const manifest: ReleaseManifest = { ...entry(version), releases: [version, ...history].map(entry) };
  return JSON.stringify(manifest);
}

describe("publish", () => {
  test("the very first release: no manifest in the store yet", async () => {
    const blob = fakeBlob(null);
    const result = await publish(input("2.0.0"), blob);

    expect(result.firstRelease).toBe(true);
    expect(result.manifest.version).toBe("2.0.0");
    expect(result.manifest.releases.map((r) => r.version)).toEqual(["2.0.0"]);
    expect(result.dmgUrl).toBe(`${STORE}/releases/LocalhostAliases-2.0.0.dmg`);
  });

  test("uploads to the frozen paths, DMG first then the manifest", async () => {
    const blob = fakeBlob(null);
    await publish(input("2.0.0"), blob);

    expect(blob.files).toEqual([
      {
        pathname: "releases/LocalhostAliases-2.0.0.dmg",
        filePath: "dist/LocalhostAliases-2.0.0.dmg",
        contentType: "application/x-apple-diskimage",
      },
    ]);
    expect(blob.jsons).toHaveLength(1);
    expect(blob.jsons[0]?.pathname).toBe("releases/latest.json");
    expect(blob.jsons[0]?.maxAgeSeconds).toBe(60);
  });

  test("prepends: publishing 2.1.0 does not erase 2.0.0", async () => {
    const blob = fakeBlob(published("2.0.0", ["1.9.0"]));
    const result = await publish(input("2.1.0"), blob);

    expect(result.firstRelease).toBe(false);
    expect(result.manifest.releases.map((r) => r.version)).toEqual(["2.1.0", "2.0.0", "1.9.0"]);
    expect(result.manifest.releases[1]?.dmg.sha256).toBe("sha-2.0.0");
    expect(result.manifest.releases[1]?.notes).toBe("notes 2.0.0");
  });

  test("a corrupt manifest in the store still publishes, with an empty history", async () => {
    const blob = fakeBlob("<!doctype html><h1>502 Bad Gateway</h1>");
    const result = await publish(input("2.1.0"), blob);

    expect(result.manifest.releases.map((r) => r.version)).toEqual(["2.1.0"]);
    expect(blob.jsons).toHaveLength(1);
  });

  test("a half-written manifest keeps whatever entries are still legible", async () => {
    const blob = fakeBlob(
      JSON.stringify({ version: "2.0.0", releases: [{ nope: true }, JSON.parse(published("1.9.0"))] }),
    );
    const result = await publish(input("2.1.0"), blob);

    expect(result.manifest.releases.map((r) => r.version)).toEqual(["2.1.0", "1.9.0"]);
  });

  test("refuses to advertise a version older than the one already published", async () => {
    const blob = fakeBlob(published("2.1.0"));
    await expect(publish(input("2.0.0"), blob)).rejects.toThrow(/already advertises 2\.1\.0/);
    expect(blob.files).toHaveLength(0);
    expect(blob.jsons).toHaveLength(0);
  });

  test("--allow-downgrade overrides that, deliberately", async () => {
    const blob = fakeBlob(published("2.1.0"));
    const result = await publish(input("2.0.0", { allowDowngrade: true }), blob);
    expect(result.manifest.version).toBe("2.0.0");
    expect(result.manifest.releases.map((r) => r.version)).toEqual(["2.0.0", "2.1.0"]);
  });

  test("re-publishing the same version is allowed and replaces the entry", async () => {
    const blob = fakeBlob(published("2.0.0", ["1.9.0"]));
    const result = await publish(input("2.0.0", { notes: "re-cut" }), blob);

    expect(result.manifest.releases.map((r) => r.version)).toEqual(["2.0.0", "1.9.0"]);
    expect(result.manifest.releases[0]?.notes).toBe("re-cut");
  });

  test("refuses a DMG whose filename does not match the version, before uploading anything", async () => {
    const blob = fakeBlob(null);
    await expect(
      publish(input("2.1.0", { filename: "LocalhostAliases-2.0.0.dmg" }), blob),
    ).rejects.toThrow(/must ship as LocalhostAliases-2\.1\.0\.dmg/);
    expect(blob.files).toHaveLength(0);
  });

  test("the manifest it writes is exactly the manifest it returns", async () => {
    const blob = fakeBlob(published("2.0.0"));
    const result = await publish(input("2.1.0"), blob);
    expect(blob.jsons[0]?.value).toEqual(result.manifest);
  });
});

describe("dmgPathname", () => {
  test("is the frozen releases/ prefix", () => {
    expect(dmgPathname(dmgFilename("2.0.0"))).toBe("releases/LocalhostAliases-2.0.0.dmg");
  });
});

describe("hashFile", () => {
  test("matches the sha256 the shell would compute, and counts the bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "la-publish-"));
    try {
      const path = join(dir, "sample.bin");
      await Bun.write(path, "hello");
      const { sha256, size } = await hashFile(path);

      // echo -n hello | shasum -a 256
      expect(sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      expect(size).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("says which file is missing", async () => {
    await expect(hashFile(join(tmpdir(), "la-publish-nope.dmg"))).rejects.toThrow(/does not exist/);
  });
});
