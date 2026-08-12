/**
 * Every test here points LA_HOSTS_PATH at a temp file. Core's `hostsPath()` resolves the
 * variable on each call, so the real /etc/hosts is never in reach.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTS_BEGIN } from "@localhost-aliases/core";
import { managedHostnames, readManagedHosts, reconcileHosts } from "../src/hosts-sync.ts";

const ORIGINAL = "##\n# Host Database\n#\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n";

let dir: string;
let hostsFile: string;
let previous: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "la-hosts-"));
  hostsFile = join(dir, "hosts");
  await Bun.write(hostsFile, ORIGINAL);
  previous = process.env.LA_HOSTS_PATH;
  process.env.LA_HOSTS_PATH = hostsFile;
});

afterEach(() => {
  if (previous === undefined) delete process.env.LA_HOSTS_PATH;
  else process.env.LA_HOSTS_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("managedHostnames", () => {
  test("lowercases, dedupes and sorts so the block depends on the set, not the order", () => {
    expect(managedHostnames(["b.local", "A.local", "b.local"])).toEqual(["a.local", "b.local"]);
  });
});

describe("reconcileHosts", () => {
  test("writes the managed block and preserves the original content", async () => {
    const result = await reconcileHosts(["myapp.local", "api.local"]);
    expect(result.changed).toBe(true);
    const content = await Bun.file(hostsFile).text();
    expect(content.startsWith(ORIGINAL)).toBe(true);
    expect(content).toContain(HOSTS_BEGIN);
    expect(content).toContain("127.0.0.1\tapi.local");
    expect(content).toContain("::1\tmyapp.local");
    expect(await readManagedHosts()).toEqual(["api.local", "myapp.local"]);
  });

  test("a second identical apply changes nothing and does not flush DNS", async () => {
    await reconcileHosts(["myapp.local"]);
    const after = await Bun.file(hostsFile).text();
    const again = await reconcileHosts(["myapp.local"]);
    expect(again.changed).toBe(false);
    expect(again.dnsFlushed).toBe(false);
    expect(await Bun.file(hostsFile).text()).toBe(after);
  });

  test("reordering the same aliases is a no-op", async () => {
    await reconcileHosts(["a.local", "b.local"]);
    const result = await reconcileHosts(["b.local", "a.local"]);
    expect(result.changed).toBe(false);
  });

  test("an empty route set removes the block entirely", async () => {
    await reconcileHosts(["myapp.local"]);
    const result = await reconcileHosts([]);
    expect(result.changed).toBe(true);
    expect(await Bun.file(hostsFile).text()).toBe(ORIGINAL);
    expect(await readManagedHosts()).toEqual([]);
  });

  test("readManagedHosts is [] when the file has no block", async () => {
    expect(await readManagedHosts()).toEqual([]);
  });
});
