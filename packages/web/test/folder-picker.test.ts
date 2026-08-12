/**
 * The folder picker, with osascript stubbed everywhere it matters.
 *
 * No test in this file may open a dialog: the real dialog is unreachable because
 * every `pickFolder()` call here injects its own runner, and the one test that
 * spawns a real process spawns `/bin/sh`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  PickFolderError,
  classifyOsascript,
  pickFolder,
  posixCandidates,
  resolveManualPath,
  runProcess,
  stripTrailingSlash,
  type OsascriptResult,
} from "../lib/folder-picker.ts";

function result(over: Partial<OsascriptResult> = {}): OsascriptResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...over };
}

/** Never called: proves a code path spawned nothing. */
const forbiddenRunner = async (): Promise<OsascriptResult> => {
  throw new Error("osascript must not be spawned here");
};

describe("stripTrailingSlash", () => {
  test("drops the separator `POSIX path of` adds to folders", () => {
    expect(stripTrailingSlash("/Users/kevin/code/")).toBe("/Users/kevin/code");
    expect(stripTrailingSlash("/Users/kevin/code///")).toBe("/Users/kevin/code");
  });

  test("keeps the root", () => {
    expect(stripTrailingSlash("/")).toBe("/");
  });
});

describe("posixCandidates (HFS -> POSIX)", () => {
  test("passes a POSIX answer through, spaces and non-ASCII intact", () => {
    // Exactly what `POSIX path of` returned in the verification run.
    expect(posixCandidates("/private/tmp/scratch/Café Ørsted Dossier/\n")).toEqual([
      "/private/tmp/scratch/Café Ørsted Dossier",
    ]);
  });

  test("converts a boot-volume HFS colon path", () => {
    expect(posixCandidates("Macintosh HD:Users:kevin:Café Ørsted Dossier:")).toEqual([
      "/Users/kevin/Café Ørsted Dossier",
      "/Volumes/Macintosh HD/Users/kevin/Café Ørsted Dossier",
    ]);
  });

  test("offers the /Volumes form for an external volume", () => {
    // Which of the two is right depends on where the volume is mounted, which
    // the string cannot say — the caller picks the one that is a directory.
    expect(posixCandidates("Backup SSD:Projects:app")).toEqual([
      "/Projects/app",
      "/Volumes/Backup SSD/Projects/app",
    ]);
  });

  test("handles a bare volume", () => {
    expect(posixCandidates("Macintosh HD:")).toEqual(["/", "/Volumes/Macintosh HD"]);
  });

  test("rejects anything that is neither POSIX nor HFS", () => {
    expect(posixCandidates("")).toEqual([]);
    expect(posixCandidates("relative/path")).toEqual([]);
  });
});

describe("classifyOsascript", () => {
  test("a path is a path", () => {
    expect(classifyOsascript(result({ stdout: "/Users/kevin/x/\n" }))).toEqual({
      kind: "ok",
      raw: "/Users/kevin/x/\n",
    });
  });

  test("error -128 is a cancel, not a failure", () => {
    expect(
      classifyOsascript(result({ code: 1, stderr: "execution error: User canceled. (-128)\n" })),
    ).toEqual({ kind: "cancelled" });
  });

  test("recognises the British spelling too", () => {
    expect(classifyOsascript(result({ code: 1, stderr: "User cancelled." })).kind).toBe("cancelled");
  });

  test("a timeout outranks the exit code", () => {
    expect(classifyOsascript(result({ code: 137, timedOut: true }))).toEqual({ kind: "timeout" });
  });

  test("any other non-zero exit is a failure carrying the last stderr line", () => {
    const outcome = classifyOsascript(
      result({ code: 1, stderr: "syntax error: Expected end of line.\n" }),
    );
    expect(outcome).toEqual({ kind: "failed", message: "syntax error: Expected end of line." });
  });

  test("success with no output is a failure, not an empty path", () => {
    expect(classifyOsascript(result({ code: 0, stdout: "   \n" })).kind).toBe("failed");
  });
});

describe("pickFolder", () => {
  const alwaysDir = async () => true;

  test("activates itself and asks for a POSIX path", async () => {
    let seen = "";
    await pickFolder({
      run: async (script) => {
        seen = script;
        return result({ stdout: "/tmp\n" });
      },
      isDirectory: alwaysDir,
    });
    // Without the activate line the dialog opens behind the browser.
    expect(seen).toContain("tell me to activate");
    expect(seen).toContain("choose folder with prompt");
    expect(seen).toContain("POSIX path of chosen");
  });

  test("returns the resolved absolute path", async () => {
    await expect(
      pickFolder({ run: async () => result({ stdout: "/Users/kevin/Café Ø/\n" }), isDirectory: alwaysDir }),
    ).resolves.toEqual({ path: "/Users/kevin/Café Ø" });
  });

  test("resolves an HFS answer against the filesystem", async () => {
    const real = "/Volumes/Backup SSD/Projects/app";
    const res = await pickFolder({
      run: async () => result({ stdout: "Backup SSD:Projects:app:\n" }),
      isDirectory: async (p) => p === real,
    });
    expect(res).toEqual({ path: real });
  });

  test("a cancel is { cancelled: true }, never a throw", async () => {
    const res = await pickFolder({
      run: async () => result({ code: 1, stderr: "execution error: User canceled. (-128)" }),
      isDirectory: alwaysDir,
    });
    expect(res).toEqual({ cancelled: true });
  });

  test("a timeout is a 504 the user can read", async () => {
    const err = (await pickFolder({
      run: async () => result({ code: 137, timedOut: true }),
      isDirectory: alwaysDir,
    }).catch((e) => e)) as PickFolderError;
    expect(err).toBeInstanceOf(PickFolderError);
    expect(err.status).toBe(504);
    expect(err.message).toContain("60 seconds");
  });

  test("defaults the child's deadline to 60s", async () => {
    let seen = 0;
    await pickFolder({
      run: async (_script, ms) => {
        seen = ms;
        return result({ stdout: "/tmp\n" });
      },
      isDirectory: alwaysDir,
    });
    expect(seen).toBe(60_000);
  });

  test("a path that is not a directory is refused", async () => {
    const err = (await pickFolder({
      run: async () => result({ stdout: "/Users/kevin/gone/\n" }),
      isDirectory: async () => false,
    }).catch((e) => e)) as PickFolderError;
    expect(err).toBeInstanceOf(PickFolderError);
    expect(err.status).toBe(500);
  });

  test("LA_FOLDER_PICKER=stub returns a real directory without spawning anything", async () => {
    const res = await pickFolder({ mode: "stub", run: forbiddenRunner });
    expect(res).toEqual({ path: join(tmpdir(), "la-picked-folder") });
    // It has to survive the same validation a real answer does.
    await expect(resolveManualPath((res as { path: string }).path)).resolves.toBe(
      join(tmpdir(), "la-picked-folder"),
    );
  });

  test("the stub path is overridable, and never opens a dialog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "la-stub-"));
    try {
      const res = await pickFolder({ mode: "stub", stubPath: dir, run: forbiddenRunner });
      expect(res).toEqual({ path: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LA_FOLDER_PICKER=cancel drives the cancel UI without a dialog", async () => {
    await expect(pickFolder({ mode: "cancel", run: forbiddenRunner })).resolves.toEqual({
      cancelled: true,
    });
  });

  test("LA_FOLDER_PICKER=error drives the error UI without a dialog", async () => {
    await expect(pickFolder({ mode: "error", run: forbiddenRunner })).rejects.toBeInstanceOf(
      PickFolderError,
    );
  });
});

describe("resolveManualPath", () => {
  test("accepts a real directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "la-manual-"));
    try {
      await expect(resolveManualPath(`  ${dir}  `)).resolves.toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("normalises .., . and trailing slashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "la-manual-"));
    try {
      await expect(resolveManualPath(`${dir}/./sub/../`)).resolves.toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expands ~", async () => {
    await expect(resolveManualPath("~")).resolves.toBe(stripTrailingSlash(homedir()));
    await expect(resolveManualPath("~/", async () => true)).resolves.toBe(
      stripTrailingSlash(homedir()),
    );
  });

  test("refuses a relative path — the server has its own cwd", async () => {
    await expect(resolveManualPath("code/app")).rejects.toMatchObject({ name: "ValidationError" });
  });

  test("refuses empty input", async () => {
    await expect(resolveManualPath("   ")).rejects.toMatchObject({ name: "ValidationError" });
  });

  test("refuses a path that does not exist", async () => {
    await expect(resolveManualPath("/definitely/not/here/at/all")).rejects.toMatchObject({
      name: "ValidationError",
    });
  });

  test("refuses a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "la-manual-"));
    const file = join(dir, "note.txt");
    await writeFile(file, "x");
    try {
      await expect(resolveManualPath(file)).rejects.toMatchObject({ name: "ValidationError" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the failure against the `path` field", async () => {
    const err = (await resolveManualPath("nope").catch((e) => e)) as { issues: unknown[] };
    expect(err.issues).toEqual([
      { field: "path", message: "must be an absolute path, starting with /" },
    ]);
  });
});

describe("runProcess", () => {
  test("kills a child that outlives the deadline, by its own pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "la-timeout-"));
    const marker = join(dir, "survived");
    try {
      const started = Date.now();
      // Stands in for a dialog nobody answers. If the kill misses, the marker
      // file appears and this test fails.
      const res = await runProcess(["/bin/sh", "-c", `sleep 1.5; echo x > "${marker}"`], 150);
      const elapsed = Date.now() - started;

      expect(res.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(1200);
      await Bun.sleep(1800);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("passes a fast child through untouched", async () => {
    const res = await runProcess(["/bin/echo", "hello"], 5_000);
    expect(res).toMatchObject({ code: 0, timedOut: false });
    expect(res.stdout.trim()).toBe("hello");
  });
});
