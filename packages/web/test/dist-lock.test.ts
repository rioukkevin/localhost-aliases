/**
 * The build-directory lock. Everything here runs in a temp cwd against fake lock files —
 * no Next.js server is started, and the real `.next` is never involved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimDistDir, conflictingServer, dashboardPort, distDir } from "../lib/dist-lock.ts";

const cwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "la-lock-"));
const LOCK = join(dir, ".next-test.lock");

/** A pid that is certainly not running: pid 1 is launchd, and 2^22 is above pid_max. */
const DEAD_PID = 4_194_303;

function writeLock(pid: number, port: string): void {
  writeFileSync(LOCK, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }));
}

beforeAll(() => {
  process.chdir(dir);
  process.env.LA_NEXT_DIST_DIR = ".next-test";
  process.env.LA_DASHBOARD_PORT = "7788";
});

afterEach(() => {
  rmSync(LOCK, { force: true });
});

afterAll(() => {
  process.chdir(cwd);
  delete process.env.LA_NEXT_DIST_DIR;
  delete process.env.LA_DASHBOARD_PORT;
  rmSync(dir, { recursive: true, force: true });
});

describe("distDir", () => {
  test("defaults to .next and is overridden by LA_NEXT_DIST_DIR", () => {
    expect(distDir()).toBe(".next-test");
    delete process.env.LA_NEXT_DIST_DIR;
    expect(distDir()).toBe(".next");
    process.env.LA_NEXT_DIST_DIR = ".next-test";
  });

  test("dashboardPort defaults to 7788", () => {
    expect(dashboardPort()).toBe("7788");
  });
});

describe("conflictingServer", () => {
  test("is null when nothing holds the directory", () => {
    expect(conflictingServer()).toBeNull();
  });

  test("names the other server, its port and the escape hatch", () => {
    writeLock(process.pid === 1 ? 2 : 1, "9999"); // pid 1 is always alive
    const conflict = conflictingServer();
    expect(conflict).toContain("port 9999");
    expect(conflict).toContain(".next-test/");
    expect(conflict).toContain("LA_NEXT_DIST_DIR");
  });

  test("lets our own server tree through: same port means the same `next dev`", () => {
    writeLock(1, "7788");
    expect(conflictingServer()).toBeNull();
  });

  test("a dead holder is stale, not a conflict", () => {
    writeLock(DEAD_PID, "9999");
    expect(conflictingServer()).toBeNull();
  });

  test("a corrupt lock file is ignored rather than fatal", () => {
    writeFileSync(LOCK, "{not json");
    expect(conflictingServer()).toBeNull();
  });
});

describe("claimDistDir", () => {
  test("writes our pid and port beside the build directory, never inside it", () => {
    claimDistDir();
    expect(existsSync(LOCK)).toBe(true);
    // Inside distDir the lock would be wiped by `next dev` moments after being taken.
    expect(existsSync(join(dir, ".next-test"))).toBe(false);

    const record = JSON.parse(readFileSync(LOCK, "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.port).toBe("7788");
    // Our own record must never look like a conflict to us.
    expect(conflictingServer()).toBeNull();
  });
});
