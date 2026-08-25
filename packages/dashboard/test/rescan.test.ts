/**
 * The rescan button's whole reason to exist is defeating the detection cache. If
 * forgetStackFor misses, the button returns the answer the user is already looking at
 * and appears broken — so that is what these lock down.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearStackCache,
  detectStackCached,
  forgetStackFor,
  stackCacheSize,
} from "../lib/stack-hints.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function project(deps: Record<string, string>): string {
  const dir = mkdtempSync("/tmp/la-rescan-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps }));
  return dir;
}

describe("forgetStackFor", () => {
  beforeEach(() => clearStackCache());

  test("drops the cached answer so the next read hits disk", async () => {
    const dir = project({ next: "15.0.0" });
    const first = await detectStackCached(dir, 3000);
    expect(first?.framework.toLowerCase()).toContain("next");
    expect(stackCacheSize()).toBe(1);

    // Framework changes on disk. Without forgetting, the cache would still say Next.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { vite: "5.0.0" } }));
    expect((await detectStackCached(dir, 3000))?.framework.toLowerCase()).toContain("next");

    expect(forgetStackFor(dir)).toBe(1);
    expect(stackCacheSize()).toBe(0);
    expect((await detectStackCached(dir, 3000))?.framework.toLowerCase()).toContain("vite");
  });

  test("drops every port's entry for the folder", async () => {
    const dir = project({ next: "15.0.0" });
    await detectStackCached(dir, 3000);
    await detectStackCached(dir, 4000);
    expect(stackCacheSize()).toBe(2);
    expect(forgetStackFor(dir)).toBe(2);
    expect(stackCacheSize()).toBe(0);
  });

  test("leaves other folders alone, including suffix look-alikes", async () => {
    const a = project({ next: "15.0.0" });
    const b = mkdtempSync("/tmp/la-rescan-");
    mkdirSync(join(b, "inner"), { recursive: true });
    writeFileSync(join(b, "package.json"), JSON.stringify({ name: "y", dependencies: { vite: "5.0.0" } }));

    await detectStackCached(a, 3000);
    await detectStackCached(b, 3000);
    expect(stackCacheSize()).toBe(2);

    expect(forgetStackFor(a)).toBe(1);
    expect(stackCacheSize()).toBe(1);
  });

  test("an unknown folder or empty path drops nothing and does not throw", async () => {
    const dir = project({ next: "15.0.0" });
    await detectStackCached(dir, 3000);
    expect(forgetStackFor("/tmp/never-cached-xyz")).toBe(0);
    expect(forgetStackFor("")).toBe(0);
    expect(forgetStackFor("   ")).toBe(0);
    expect(stackCacheSize()).toBe(1);
  });
});
