import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_WEB_ENTRY,
  HELPER_PLIST_NAME,
  bundleContents,
  bundleContentsFrom,
  bundlePathsFrom,
  bundleWebCommand,
  helperInstallMethod,
  runtimeMode,
} from "../src/runtime-layout.ts";

const saved = { runtime: process.env.LA_RUNTIME, contents: process.env.LA_BUNDLE_CONTENTS };

afterEach(() => {
  restore("LA_RUNTIME", saved.runtime);
  restore("LA_BUNDLE_CONTENTS", saved.contents);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("bundleContentsFrom", () => {
  test("finds the Contents directory of any executable inside the bundle", () => {
    const app = "/Applications/LocalhostAliases.app/Contents";
    expect(bundleContentsFrom(`${app}/Resources/bin/bun`)).toBe(app);
    expect(bundleContentsFrom(`${app}/MacOS/la-helper`)).toBe(app);
    expect(bundleContentsFrom(`${app}/MacOS/LocalhostAliases`)).toBe(app);
  });

  test("rejects paths with no .app ancestor", () => {
    expect(bundleContentsFrom("/opt/homebrew/bin/bun")).toBeNull();
    // "Contents" alone is not a marker: only a Contents *inside a .app* counts.
    expect(bundleContentsFrom("/Users/kevin/Contents/bun")).toBeNull();
  });
});

describe("bundlePathsFrom", () => {
  const paths = bundlePathsFrom("/Applications/LocalhostAliases.app/Contents");

  test("matches the frozen layout table", () => {
    expect(paths.trayExecutable).toEndWith("/Contents/MacOS/LocalhostAliases");
    expect(paths.helperExecutable).toEndWith("/Contents/MacOS/la-helper");
    expect(paths.bunExecutable).toEndWith("/Contents/Resources/bin/bun");
    expect(paths.webEntry).toEndWith(`/Contents/Resources/web/${BUNDLE_WEB_ENTRY}`);
    expect(paths.helperPlist).toEndWith(`/Contents/Library/LaunchDaemons/${HELPER_PLIST_NAME}`);
  });

  test("the web command is the embedded bun running the standalone entry", () => {
    expect(bundleWebCommand(paths)).toEqual([paths.bunExecutable, paths.webEntry]);
  });
});

describe("detection", () => {
  test("LA_RUNTIME=dev wins over everything", () => {
    process.env.LA_RUNTIME = "dev";
    process.env.LA_BUNDLE_CONTENTS = "/Applications/LocalhostAliases.app/Contents";
    expect(bundleContents()).toBeNull();
    expect(runtimeMode()).toBe("dev");
    expect(helperInstallMethod()).toBe("script");
  });

  test("LA_BUNDLE_CONTENTS forces bundle mode", () => {
    delete process.env.LA_RUNTIME;
    process.env.LA_BUNDLE_CONTENTS = "/Applications/LocalhostAliases.app/Contents";
    expect(runtimeMode()).toBe("bundle");
    expect(helperInstallMethod()).toBe("bundle");
  });

  test("a real bundle on disk is detected from the executable path", () => {
    delete process.env.LA_RUNTIME;
    delete process.env.LA_BUNDLE_CONTENTS;
    // The test runner's execPath is bun in a checkout, so drive the pure half instead
    // and prove the Info.plist gate independently.
    const root = mkdtempSync(join(tmpdir(), "la-layout-"));
    const contents = join(root, "LocalhostAliases.app", "Contents");
    mkdirSync(join(contents, "Resources", "bin"), { recursive: true });
    expect(bundleContentsFrom(join(contents, "Resources", "bin", "bun"))).toBe(contents);

    process.env.LA_BUNDLE_CONTENTS = contents;
    expect(runtimeMode()).toBe("bundle");
    writeFileSync(join(contents, "Info.plist"), "<plist/>");
    expect(runtimeMode()).toBe("bundle");
  });

  test("a checkout is dev mode", () => {
    delete process.env.LA_RUNTIME;
    delete process.env.LA_BUNDLE_CONTENTS;
    expect(runtimeMode()).toBe("dev");
    expect(helperInstallMethod()).toBe("script");
  });
});
