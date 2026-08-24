/**
 * teardown.sh — the whole uninstall, driven without ever uninstalling anything.
 *
 * NOTHING here touches the machine. Every path is a temp directory, `osascript`, `security`
 * and `openssl` are stubs on PATH (and pinned through LA_* so a PATH mistake cannot reach the
 * real ones), and the "app bundle" is a directory that looks like ours. The real privileged
 * script is never reached: the osascript stub stands in for the admin prompt.
 *
 * The two properties under test are the two defects this file was written for:
 *   1. a failing step must NOT stop the steps after it (the run that never removed the .app);
 *   2. the .app is removed from OUTSIDE itself, after the app's pid is gone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIV_DIR, run } from "./helpers.ts";

const TEARDOWN = join(PRIV_DIR, "teardown.sh");
const SELF_DELETE = join(PRIV_DIR, "self-delete.sh");

/** POSIX single-quoting, for the stub bodies below. */
function q(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Box {
  root: string;
  configDir: string;
  logDir: string;
  appBundle: string;
  binDir: string;
  /** argv lines each stub was called with. */
  calls(name: "osascript" | "security"): string[];
  env(extra?: Record<string, string>): Record<string, string>;
}

const boxes: string[] = [];

/**
 * `exitCode` / `output` shape the osascript stub — that is how a cancelled prompt and a
 * failing privileged script are simulated without a prompt or a privileged script.
 */
function makeBox(options: { osascriptExit?: number; osascriptOutput?: string; securityExit?: number } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), "la-teardown-"));
  boxes.push(root);
  const configDir = join(root, "config");
  const logDir = join(root, "logs");
  const binDir = join(root, "bin");
  const appsDir = join(root, "Applications");
  const appBundle = join(appsDir, "LocalhostAliases.app");

  for (const dir of [configDir, join(configDir, "ca"), logDir, binDir, join(appBundle, "Contents", "MacOS")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ aliases: [{ ip: "127.0.0.2" }, { ip: "127.0.0.7" }] }));
  writeFileSync(join(logDir, "tray.log"), "hello\n");
  writeFileSync(join(appBundle, "Contents", "Info.plist"), "<plist>dev.localhost-aliases.app</plist>");
  writeFileSync(join(appBundle, "Contents", "MacOS", "LocalhostAliases"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(appBundle, "Contents", "MacOS", "LocalhostAliases"), 0o755);

  const callLog = (name: string) => join(root, `${name}.calls`);
  for (const name of ["osascript", "security", "openssl"]) writeFileSync(callLog(name), "");

  script(
    join(binDir, "osascript"),
    `printf '%s\\n' "$*" >> ${q(callLog("osascript"))}
printf '%s\\n' ${q(options.osascriptOutput ?? "LA_RESULT status=ok ips_removed=2 hosts=changed")}
exit ${options.osascriptExit ?? 0}`,
  );
  script(
    join(binDir, "security"),
    `printf '%s\\n' "$*" >> ${q(callLog("security"))}
exit ${options.securityExit ?? 0}`,
  );
  // Only ever asked for a fingerprint; the shape mirrors the real output.
  script(join(binDir, "openssl"), `printf 'SHA1 Fingerprint=AA:BB:CC:DD\\n'\nexit 0`);

  return {
    root,
    configDir,
    logDir,
    appBundle,
    binDir,
    calls: (name) => readFileSync(callLog(name), "utf8").split("\n").filter(Boolean),
    env: (extra = {}) => ({
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: root,
      TMPDIR: join(root, "tmp") + "/",
      LA_CONFIG_DIR: configDir,
      LA_LOG_DIR: logDir,
      LA_APP_BUNDLE: appBundle,
      LA_KEYCHAIN: join(root, "login.keychain-db"),
      LA_OSASCRIPT: join(binDir, "osascript"),
      LA_SECURITY: join(binDir, "security"),
      LA_OPENSSL: join(binDir, "openssl"),
      ...extra,
    }),
  };
}

afterEach(() => {
  while (boxes.length > 0) rmSync(boxes.pop()!, { recursive: true, force: true });
});

const teardown = (box: Box, extra: Record<string, string> = {}, args: string[] = []) => {
  mkdirSync(join(box.root, "tmp"), { recursive: true });
  return run(["/bin/bash", TEARDOWN, ...args], box.env(extra));
};

/** `LA_STEP <name> <status> <detail…>` -> { name: status }. */
function steps(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("LA_STEP ")) continue;
    const [, name, status] = line.split(/\s+/);
    if (name && status) out[name] = status;
  }
  return out;
}

function detail(stdout: string, step: string): string {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`LA_STEP ${step} `));
  return line ? line.split(/\s+/).slice(3).join(" ") : "";
}

describe("teardown.sh — the sequence", () => {
  test("runs every step and reports each one", async () => {
    const box = makeBox();
    writeFileSync(join(box.configDir, "ca", "rootCA.pem"), "-----BEGIN CERTIFICATE-----\n");

    const r = await teardown(box);

    expect(r.code).toBe(0);
    expect(steps(r.stdout)).toEqual({ system: "ok", ca: "ok", config: "ok", logs: "ok", app: "ok" });
    expect(r.summary).toMatchObject({ status: "ok", failed: "0", app: "removed" });
    expect(existsSync(box.configDir)).toBe(false);
    expect(existsSync(box.logDir)).toBe(false);
    expect(existsSync(box.appBundle)).toBe(false);
  });

  test("removes the CA by SHA-1 fingerprint from the login keychain, never by name", async () => {
    const box = makeBox();
    writeFileSync(join(box.configDir, "ca", "rootCA.pem"), "-----BEGIN CERTIFICATE-----\n");
    await teardown(box);
    expect(box.calls("security")).toEqual([
      `delete-certificate -Z AABBCCDD -t ${join(box.root, "login.keychain-db")}`,
    ]);
  });

  test("skips the CA step when nothing was ever trusted", async () => {
    const box = makeBox();
    const r = await teardown(box);
    expect(steps(r.stdout).ca).toBe("skipped");
    expect(box.calls("security")).toEqual([]);
    expect(r.summary.status).toBe("ok");
  });

  test("hands root the owner and the managed IPs, so it cannot leave root-owned files behind", async () => {
    const box = makeBox();
    const [call] = box.calls("osascript").length > 0 ? box.calls("osascript") : [""];
    expect(call).toBe("");
    await teardown(box);
    const command = box.calls("osascript").join("\n");
    expect(command).toContain(`LA_CONFIG_DIR='${box.configDir}'`);
    expect(command).toContain(`LA_LOG_DIR='${box.logDir}'`);
    expect(command).toMatch(/LA_OWNER='\d+:\d+'/);
    expect(command).toContain(`LA_MANAGED_IPS='127.0.0.2 127.0.0.7'`);
    expect(command).toContain("with administrator privileges");
  });
});

// ---------------------------------------------------------------------------
// The abort. This is the defect: one failing step used to end the run, and the .app —
// the LAST step — was therefore never removed on the machine whose system state had
// already been torn down.
// ---------------------------------------------------------------------------

describe("teardown.sh — a failed step never stops the ones after it", () => {
  test("the privileged step failing still removes the CA, the config, the logs and the app", async () => {
    const box = makeBox({ osascriptExit: 1, osascriptOutput: "rm: /etc/hosts: Permission denied" });
    writeFileSync(join(box.configDir, "ca", "rootCA.pem"), "-----BEGIN CERTIFICATE-----\n");

    const r = await teardown(box);

    expect(steps(r.stdout)).toEqual({ system: "failed", ca: "ok", config: "ok", logs: "ok", app: "ok" });
    expect(r.summary).toMatchObject({ status: "partial", failed: "1", app: "removed" });
    expect(r.code).toBe(1);
    expect(existsSync(box.appBundle)).toBe(false);
    expect(detail(r.stdout, "system")).toContain("Permission denied");
  });

  test("the keychain step failing still removes the config, the logs and the app", async () => {
    const box = makeBox({ securityExit: 1 });
    writeFileSync(join(box.configDir, "ca", "rootCA.pem"), "-----BEGIN CERTIFICATE-----\n");

    const r = await teardown(box);

    // A certificate that is not there is not a failure — it is the normal state for anyone
    // who never enabled https. Everything after it runs either way.
    expect(steps(r.stdout).ca).toBe("skipped");
    expect(steps(r.stdout)).toMatchObject({ config: "ok", logs: "ok", app: "ok" });
    expect(existsSync(box.appBundle)).toBe(false);
  });

  test("an undeletable config directory still removes the logs and the app", async () => {
    const box = makeBox();
    // Exactly the shape of the reported bug: something inside the config dir cannot be
    // removed by this user. A read-only parent reproduces it with no root anywhere.
    const locked = join(box.root, "locked");
    mkdirSync(join(locked, "state"), { recursive: true });
    writeFileSync(join(locked, "state", "privileged.log"), "root wrote this\n");
    chmodSync(locked, 0o500);

    const r = await teardown(box, { LA_CONFIG_DIR: join(locked, "state") });

    chmodSync(locked, 0o700); // so afterEach can clean up
    expect(steps(r.stdout).config).toBe("failed");
    expect(steps(r.stdout)).toMatchObject({ logs: "ok", app: "ok" });
    expect(r.summary).toMatchObject({ status: "partial", failed: "1", app: "removed" });
    expect(existsSync(box.appBundle)).toBe(false);
    expect(existsSync(join(locked, "state"))).toBe(true);
  });

  test("a missing self-delete helper fails only the app step", async () => {
    const box = makeBox();
    // teardown.sh looks for its helper beside itself; pointing LA_SELF_DIR is not a knob, so
    // this is exercised through a copy of the script in a directory with no helper.
    const alone = join(box.root, "alone");
    mkdirSync(alone, { recursive: true });
    writeFileSync(join(alone, "teardown.sh"), readFileSync(TEARDOWN, "utf8"));
    writeFileSync(join(alone, "uninstall.sh"), "#!/bin/bash\nexit 0\n");

    mkdirSync(join(box.root, "tmp"), { recursive: true });
    const r = await run(["/bin/bash", join(alone, "teardown.sh")], box.env());

    expect(steps(r.stdout)).toMatchObject({ config: "ok", logs: "ok", app: "failed" });
    expect(r.summary.status).toBe("partial");
    expect(existsSync(box.appBundle)).toBe(true);
    expect(detail(r.stdout, "app")).toContain("by hand");
  });

  test("every step still runs when the whole run is one long failure", async () => {
    const box = makeBox({ osascriptExit: 1, osascriptOutput: "something broke" });
    const alone = join(box.root, "alone");
    mkdirSync(alone, { recursive: true });
    writeFileSync(join(alone, "teardown.sh"), readFileSync(TEARDOWN, "utf8"));

    mkdirSync(join(box.root, "tmp"), { recursive: true });
    const r = await run(["/bin/bash", join(alone, "teardown.sh")], box.env());

    // No uninstall.sh AND no self-delete.sh beside it: both ends fail, the middle still runs.
    expect(steps(r.stdout)).toEqual({ system: "failed", ca: "skipped", config: "ok", logs: "ok", app: "failed" });
    expect(r.summary).toMatchObject({ status: "partial", failed: "2" });
    expect(existsSync(box.configDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cancelling is a decision, not a failure.
// ---------------------------------------------------------------------------

describe("teardown.sh — a dismissed password prompt", () => {
  test("stops before anything is removed", async () => {
    const box = makeBox({ osascriptExit: 1, osascriptOutput: "osascript: User canceled. (-128)" });
    const r = await teardown(box);

    expect(r.code).toBe(2);
    expect(r.summary).toMatchObject({ status: "cancelled", app: "kept" });
    expect(existsSync(box.configDir)).toBe(true);
    expect(existsSync(box.logDir)).toBe(true);
    expect(existsSync(box.appBundle)).toBe(true);
    expect(box.calls("security")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-deletion: from outside the bundle, after the app's pid is gone.
// ---------------------------------------------------------------------------

describe("teardown.sh — removing the app", () => {
  test("with LA_WAIT_PID it schedules the removal instead of doing it inline", async () => {
    const box = makeBox();
    const sleeper = Bun.spawn(["/bin/sleep", "1"], { stdout: "ignore", stderr: "ignore" });

    const r = await teardown(box, { LA_WAIT_PID: String(sleeper.pid) });

    expect(steps(r.stdout).app).toBe("scheduled");
    expect(r.summary).toMatchObject({ status: "ok", app: "scheduled" });
    // Still there: the app is still "running".
    expect(existsSync(box.appBundle)).toBe(true);

    await sleeper.exited;
    const gone = await waitFor(() => !existsSync(box.appBundle));
    expect(gone).toBe(true);
  });

  test("the helper runs from a scratch copy, never from inside the bundle it removes", async () => {
    const box = makeBox();
    const sleeper = Bun.spawn(["/bin/sleep", "1"], { stdout: "ignore", stderr: "ignore" });
    const r = await teardown(box, { LA_WAIT_PID: String(sleeper.pid) });
    expect(detail(r.stdout, "app")).toContain(`pid ${sleeper.pid}`);

    sleeper.kill();
    await sleeper.exited;
    await waitFor(() => !existsSync(box.appBundle));

    const log = readFileSync(join(box.root, "tmp", "localhost-aliases-uninstall.log"), "utf8");
    expect(log).toContain(`waiting up to`);
    expect(log).toContain("ok: removed");
    // And it took its own scratch directory with it.
    const scratch = /LA_SELF_DELETE_SCRATCH|la-uninstall\.\w+/.exec(log);
    expect(scratch === null || !existsSync(scratch[0])).toBe(true);
  });
});

describe("self-delete.sh — what it refuses", () => {
  const cases: Array<[string, (box: Box) => string]> = [
    ["a relative path", () => "Applications/LocalhostAliases.app"],
    ["a path containing ..", (box) => `${box.root}/Applications/../Applications/LocalhostAliases.app`],
    ["a bundle that is not ours by name", (box) => join(box.root, "Applications", "Something.app")],
    ["the home directory itself", (box) => join(box.root, "LocalhostAliases.app")],
  ];

  for (const [name, path] of cases) {
    test(`refuses ${name}`, async () => {
      const box = makeBox();
      mkdirSync(join(box.root, "Applications", "Something.app", "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(box.root, "LocalhostAliases.app", "Contents", "MacOS"), { recursive: true });
      const target = path(box);
      const r = await run(["/bin/bash", SELF_DELETE, target], box.env());
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("status=failed");
      // Whatever it refused is still on disk. (A relative path resolves against a cwd this
      // test does not control, so there is nothing to check for that one.)
      if (target.startsWith("/")) expect(existsSync(target)).toBe(true);
      expect(existsSync(box.appBundle)).toBe(true);
    });
  }

  test("refuses a directory that only looks like the bundle", async () => {
    const box = makeBox();
    const fake = join(box.root, "Applications2", "LocalhostAliases.app");
    mkdirSync(join(fake, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(fake, "Contents", "Info.plist"), "<plist>com.someone.else</plist>");
    writeFileSync(join(fake, "Contents", "MacOS", "LocalhostAliases"), "");

    const r = await run(["/bin/bash", SELF_DELETE, fake], box.env());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("does not declare dev.localhost-aliases.app");
    expect(existsSync(fake)).toBe(true);
  });

  test("does not linger when the pid never exits", async () => {
    const box = makeBox();
    const sleeper = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const started = Date.now();
    const r = await run(
      ["/bin/bash", SELF_DELETE, box.appBundle, String(sleeper.pid)],
      box.env({ LA_SELF_DELETE_TIMEOUT: "1" }),
    );
    sleeper.kill();
    await sleeper.exited;

    expect(r.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stdout).toContain("still running");
    // And it left the bundle alone rather than pulling it out from under a live process.
    expect(existsSync(box.appBundle)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --dry-run: the exact commands, and not one of them run.
// ---------------------------------------------------------------------------

describe("teardown.sh --dry-run", () => {
  test("prints every command with its variables expanded and changes nothing", async () => {
    const box = makeBox();
    writeFileSync(join(box.configDir, "ca", "rootCA.pem"), "-----BEGIN CERTIFICATE-----\n");

    const r = await teardown(box, {}, ["--dry-run"]);

    expect(r.code).toBe(0);
    expect(steps(r.stdout)).toEqual({
      system: "dry-run", ca: "dry-run", config: "dry-run", logs: "dry-run", app: "dry-run",
    });
    expect(detail(r.stdout, "system")).toContain(`LA_CONFIG_DIR='${box.configDir}'`);
    expect(detail(r.stdout, "system")).toContain(`/bin/bash '${join(PRIV_DIR, "uninstall.sh")}'`);
    expect(detail(r.stdout, "ca")).toContain(`delete-certificate -Z AABBCCDD`);
    expect(detail(r.stdout, "config")).toBe(`/bin/rm -rf ${box.configDir}`);
    expect(detail(r.stdout, "logs")).toBe(`/bin/rm -rf ${box.logDir}`);
    expect(detail(r.stdout, "app")).toContain(box.appBundle);

    // Nothing ran.
    expect(box.calls("osascript")).toEqual([]);
    expect(box.calls("security")).toEqual([]);
    expect(existsSync(box.configDir)).toBe(true);
    expect(existsSync(box.logDir)).toBe(true);
    expect(existsSync(box.appBundle)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The `rm -rf` targets are not trusted just because an environment variable said so.
// ---------------------------------------------------------------------------

describe("teardown.sh — refusing a directory that is never ours", () => {
  // LA_CONFIG_DIR/LA_LOG_DIR are honoured everywhere (paths.ts, Paths.swift, `make uninstall`),
  // which means a stale export in someone's shell picks the argument to `rm -rf`. These are
  // the paths that must be refused however they arrive.
  const forbidden = (home: string): string[] => [
    "/",
    "/Users",
    "/Applications",
    "/etc",
    "/Library",
    "/System",
    "/private/var",
    home,
    `${home}/`,
    `${home}/.config`,
    `${home}/Library`,
    `${home}/Library/Logs`,
    `${home}/Desktop`,
  ];

  test("refuses every one of them, for the config step and the logs step alike", async () => {
    for (const path of forbidden("/Users/nobody")) {
      const box = makeBox();
      const r = await teardown(box, { HOME: "/Users/nobody", LA_CONFIG_DIR: path, LA_LOG_DIR: path });
      expect(steps(r.stdout).config).toBe("failed");
      expect(steps(r.stdout).logs).toBe("failed");
      expect(detail(r.stdout, "config")).toContain("never this app's directory");
      expect(r.summary.status).toBe("partial");
    }
  });

  test("a refusal does not stop the app from being removed", async () => {
    const box = makeBox();
    const r = await teardown(box, { HOME: "/Users/nobody", LA_CONFIG_DIR: "/Users/nobody" });
    expect(steps(r.stdout)).toMatchObject({ config: "failed", app: "ok" });
    expect(existsSync(box.appBundle)).toBe(false);
  });

  test("but the real ~/.config/localhost-aliases is still removed", async () => {
    // The guard must refuse the ancestors and nothing below them, or it would break the
    // one directory the uninstall exists to delete.
    const box = makeBox();
    const home = join(box.root, "home");
    const real = join(home, ".config", "localhost-aliases");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "config.json"), "{}");
    const logs = join(home, "Library", "Logs", "localhost-aliases");
    mkdirSync(logs, { recursive: true });

    const r = await teardown(box, { HOME: home, LA_CONFIG_DIR: real, LA_LOG_DIR: logs });

    expect(steps(r.stdout)).toMatchObject({ config: "ok", logs: "ok" });
    expect(existsSync(real)).toBe(false);
    expect(existsSync(logs)).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(true);
    expect(existsSync(join(home, "Library", "Logs"))).toBe(true);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}
