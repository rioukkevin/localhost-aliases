import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentIsRunning,
  applyArgv,
  buildCliRequest,
  cliMain,
  managedIpsFromConfig,
  parseCliArgs,
  buildAppleScript,
  buildShellCommand,
  escapeAppleScriptString,
  isCancellation,
  parseError,
  parseSummary,
  privilegedEnv,
  runPrivileged,
  shellQuote,
  uninstallArgv,
  type Exec,
  type ExecResult,
} from "../prompt.ts";

/**
 * Paths and values a user can really create, plus every shape of shell and AppleScript
 * injection. The payloads are all `id` — if an escape ever breaks, the round-trip test
 * fails loudly without anything being written or deleted.
 */
const ADVERSARIAL = [
  "/Users/me/My Projects/app",
  "/Users/me/it's mine/app",
  '/Users/me/say "hi"/app',
  "/Users/me/back\\slash/app",
  "/Users/me/$(id)/app",
  "/Users/me/`id`/app",
  "/Users/me/${HOME}/app",
  "/Users/me/a;id/app",
  "/Users/me/a && id/app",
  "/Users/me/a | id/app",
  "/Users/me/a\nid\n/app",
  "/Users/me/tab\there/app",
  "/Users/me/'; id; '/app",
  '/Users/me/" & (do shell script "id") & "/app',
  '/Users/me/\\" & (do shell script "id") & \\"/app',
  "/Users/me/emoji-\u00e9\u4e2d\u6587/app",
  "--restart-forwarder",
  "-",
  "",
];

describe("shellQuote", () => {
  test("every adversarial value survives /bin/sh verbatim", async () => {
    for (const value of ADVERSARIAL) {
      const command = buildShellCommand(["/bin/echo", value]);
      const out = await sh(command);
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe(`${value}\n`);
    }
  });

  test("environment values survive too", async () => {
    for (const value of ADVERSARIAL) {
      const command = buildShellCommand(["/bin/sh", "-c", 'printf %s "$LA_VICTIM"'], { LA_VICTIM: value });
      const out = await sh(command);
      expect(out.stdout).toBe(value);
    }
  });

  test("a quote is closed and reopened, never escaped inside the quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("plain")).toBe("'plain'");
  });

  test("a NUL byte is refused rather than truncated", () => {
    expect(() => shellQuote("a\0b")).toThrow(/NUL/);
  });

  test("an invalid environment name cannot become a second command", () => {
    expect(() => buildShellCommand(["/bin/echo"], { "X; id": "1" })).toThrow(/Invalid environment variable name/);
    expect(() => buildShellCommand(["/bin/echo"], { "1BAD": "1" })).toThrow(/Invalid environment variable name/);
    expect(() => buildShellCommand([])).toThrow(/empty/);
  });

  test("the assembled command keeps argument order", () => {
    expect(buildShellCommand(["/bin/bash", "/a b/apply.sh", "--no-forwarder", "/s.json"], { LA_CONFIG_DIR: "/c d" }))
      .toBe(`LA_CONFIG_DIR='/c d' '/bin/bash' '/a b/apply.sh' '--no-forwarder' '/s.json'`);
  });
});

describe("escapeAppleScriptString", () => {
  test("every adversarial value round-trips through a real AppleScript string literal", async () => {
    for (const value of ADVERSARIAL) {
      if (value === "") continue; // osascript prints nothing for an empty string
      const escaped = escapeAppleScriptString(value);
      const out = await osascript(`return "${escaped}"`);
      expect(out.exitCode).toBe(0);
      expect(out.stdout.replace(/\n$/, "")).toBe(value);
    }
  });

  test("the five escapes AppleScript understands, and nothing else", () => {
    expect(escapeAppleScriptString('a"b')).toBe('a\\"b');
    expect(escapeAppleScriptString("a\\b")).toBe("a\\\\b");
    expect(escapeAppleScriptString("a\nb")).toBe("a\\nb");
    expect(escapeAppleScriptString("a\rb")).toBe("a\\rb");
    expect(escapeAppleScriptString("a\tb")).toBe("a\\tb");
    expect(escapeAppleScriptString("$(id) `id` ;id")).toBe("$(id) `id` ;id");
  });

  test("a backslash before a quote cannot smuggle the quote through", () => {
    expect(escapeAppleScriptString('\\"')).toBe('\\\\\\"');
  });
});

describe("buildAppleScript", () => {
  test("raises exactly one prompt", () => {
    const script = buildAppleScript(buildShellCommand(["/bin/echo", "hi"]));
    expect(script.split("with administrator privileges")).toHaveLength(2);
    expect(script.startsWith('do shell script "')).toBe(true);
  });

  test("a prompt with a quote in it stays inside its literal", () => {
    const script = buildAppleScript("echo hi", 'Localhost Aliases needs to edit "/etc/hosts"');
    expect(script).toContain('with prompt "Localhost Aliases needs to edit \\"/etc/hosts\\""');
    expect(script.endsWith("with administrator privileges")).toBe(true);
  });

  test("a command containing a quote does not end the literal early", () => {
    const command = buildShellCommand(["/bin/echo", '" & (do shell script "id") & "']);
    const script = buildAppleScript(command);
    const open = 'do shell script "';
    const close = '" with administrator privileges';
    expect(script.startsWith(open)).toBe(true);
    expect(script.endsWith(close)).toBe(true);
    // Whatever is between the quotes must contain no quote that AppleScript would honour.
    const literal = script.slice(open.length, script.length - close.length);
    expect(literal.replace(/\\\\/g, "").replace(/\\"/g, "")).not.toContain('"');
  });
});

describe("parsing the scripts' output", () => {
  test("the LA_RESULT line becomes key/value pairs", () => {
    const summary = parseSummary("noise\nLA_RESULT status=ok ips_added=2 hosts=changed pid=4242\n");
    expect(summary).toEqual({ status: "ok", ips_added: "2", hosts: "changed", pid: "4242" });
  });

  test("the last LA_RESULT line wins, and nothing else is a summary", () => {
    expect(parseSummary("LA_RESULT status=error step=hosts\nLA_RESULT status=ok pid=1\n")).toEqual({
      status: "ok",
      pid: "1",
    });
    expect(parseSummary("all quiet\n")).toBeNull();
  });

  test("the LA_ERROR line keeps its whole message", () => {
    expect(parseError('LA_ERROR step=hosts message=refusing to write /etc/hosts: it would change\n')).toEqual({
      step: "hosts",
      message: "refusing to write /etc/hosts: it would change",
    });
    expect(parseError("just a log line")).toBeNull();
  });

  test("-128 is a cancellation, other failures are not", () => {
    expect(isCancellation(1, "execution error: User canceled. (-128)")).toBe(true);
    expect(isCancellation(1, "execution error: something else (-60007)")).toBe(false);
    expect(isCancellation(0, "")).toBe(false);
  });
});

describe("runPrivileged", () => {
  const fakeExec = (result: ExecResult, seen: string[][] = []): Exec => {
    return async (argv) => {
      seen.push([...argv]);
      return result;
    };
  };

  test("a successful run returns the parsed summary", async () => {
    const seen: string[][] = [];
    const result = await runPrivileged(
      { argv: ["/bin/bash", "/a b/apply.sh", "/s.json"], env: { LA_CONFIG_DIR: "/c" }, prompt: "why" },
      { exec: fakeExec({ exitCode: 0, stdout: "LA_RESULT status=ok pid=99\n", stderr: "" }, seen) },
    );
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.summary).toEqual({ status: "ok", pid: "99" });
    expect(result.error).toBeNull();

    expect(seen[0]?.[0]).toBe("osascript");
    expect(seen[0]?.[1]).toBe("-e");
    expect(seen[0]?.[2]).toContain("with administrator privileges");
    expect(seen[0]?.[2]).toContain('with prompt "why"');
  });

  test("a cancelled prompt is a result, not a throw", async () => {
    const result = await runPrivileged(
      { argv: ["/bin/bash", "/apply.sh"] },
      { exec: fakeExec({ exitCode: 1, stdout: "", stderr: "execution error: User canceled. (-128)" }) },
    );
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
  });

  test("a failing script surfaces its step and message", async () => {
    const result = await runPrivileged(
      { argv: ["/bin/bash", "/apply.sh"] },
      {
        exec: fakeExec({
          exitCode: 1,
          stdout: "",
          stderr: "2026-01-01 log\nLA_ERROR step=hosts message=/etc/hosts is not writable\n",
        }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.error).toEqual({ step: "hosts", message: "/etc/hosts is not writable" });
  });

  test("a missing osascript is a result too, and never echoes the command", async () => {
    const secret = "/Users/me/secret-path/apply.sh";
    const result = await runPrivileged(
      { argv: ["/bin/bash", secret], env: { LA_TOKEN: "hunter2" } },
      {
        exec: async () => {
          throw new Error("spawn osascript ENOENT");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.error?.step).toBe("osascript");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});

describe("command builders", () => {
  test("apply", () => {
    expect(applyArgv("/r/privileged/apply.sh", "/c/desired-state.json")).toEqual([
      "/bin/bash",
      "/r/privileged/apply.sh",
      "/c/desired-state.json",
    ]);
    expect(applyArgv("/a.sh", "/s.json", { restartForwarder: true, noForwarder: true })).toEqual([
      "/bin/bash",
      "/a.sh",
      "--restart-forwarder",
      "--no-forwarder",
      "/s.json",
    ]);
    expect(uninstallArgv("/u.sh")).toEqual(["/bin/bash", "/u.sh"]);
  });

  test("environment", () => {
    expect(privilegedEnv({ configDir: "/c" })).toEqual({ LA_CONFIG_DIR: "/c" });
    expect(
      privilegedEnv({
        configDir: "/c",
        forwarder: "/f",
        hostsPath: "/etc/hosts",
        logDir: "/l",
        owner: "501:20",
        managedIps: ["127.0.0.2", "127.0.0.3"],
      }),
    ).toEqual({
      LA_CONFIG_DIR: "/c",
      LA_FORWARDER: "/f",
      LA_HOSTS_PATH: "/etc/hosts",
      LA_LOG_DIR: "/l",
      LA_OWNER: "501:20",
      LA_MANAGED_IPS: "127.0.0.2 127.0.0.3",
    });
    expect(privilegedEnv({ configDir: "/c", managedIps: [] }).LA_MANAGED_IPS).toBeUndefined();
  });
});

async function sh(command: string): Promise<ExecResult> {
  return capture(["/bin/sh", "-c", command]);
}
/** Evaluates a string literal only. Nothing here is ever privileged. */
async function osascript(source: string): Promise<ExecResult> {
  return capture(["osascript", "-e", source]);
}
async function capture(argv: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}


// ---------------------------------------------------------------------------
// The CLI the tray actually invokes
// ---------------------------------------------------------------------------

const PROMPT_TS = new URL("../prompt.ts", import.meta.url).pathname;

/** A config dir with a real seeded config, plus the LA_* env pointing at it. */
async function cliSandbox(): Promise<{ root: string; env: Record<string, string>; ips: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "la-cli-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const env = {
    LA_CONFIG_DIR: configDir,
    LA_LOG_DIR: join(root, "logs"),
    LA_HOSTS_PATH: join(root, "hosts"),
    LA_RUNTIME_ROOT: new URL("../../..", import.meta.url).pathname,
  };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  const core = await import("@localhost-aliases/core");
  await core.loadConfig();
  await core.createAlias({ name: "alpha", port: 3000 });
  const ips = (await core.loadConfig()).aliases.map((a) => a.ip).sort();
  for (const key of Object.keys(env)) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key]!;
  }
  return { root, env, ips };
}

describe("parseCliArgs", () => {
  test("defaults to apply and accepts both uninstall spellings", () => {
    expect(parseCliArgs([]).action).toBe("apply");
    expect(parseCliArgs(["--uninstall"]).action).toBe("uninstall");   // what the tray sends today
    expect(parseCliArgs(["uninstall"]).action).toBe("uninstall");     // subcommand form
    expect(parseCliArgs(["--restart-forwarder"])).toMatchObject({ action: "apply", restartForwarder: true });
    expect(parseCliArgs(["--no-forwarder"]).noForwarder).toBe(true);
  });

  test("an unknown argument is refused rather than silently ignored", () => {
    expect(() => parseCliArgs(["--rm-rf"])).toThrow(/Unknown argument/);
  });
});

describe("the CLI builds the privileged request", () => {
  test("apply passes the desired-state file, LA_OWNER and LA_MANAGED_IPS", async () => {
    const s = await cliSandbox();
    const previous = { ...process.env };
    Object.assign(process.env, s.env);
    try {
      const request = await buildCliRequest(parseCliArgs([]));
      expect(request.argv[0]).toBe("/bin/bash");
      expect(request.argv[1]).toMatch(/\/apply\.sh$/);
      expect(request.argv[2]).toBe(join(s.env.LA_CONFIG_DIR!, "desired-state.json"));
      // Neither the tray nor the dashboard ever supplied these; without LA_MANAGED_IPS
      // apply.sh treats every 127.0.0.2-254 address on lo0 as its own to remove.
      expect(request.env?.LA_OWNER).toMatch(/^\d+:\d+$/);
      expect(request.env?.LA_MANAGED_IPS).toBe(s.ips.join(" "));
      expect(await managedIpsFromConfig()).toEqual(s.ips);
    } finally {
      for (const key of Object.keys(s.env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key]!;
      }
    }
  });

  test("uninstall runs uninstall.sh with no desired-state argument", async () => {
    const s = await cliSandbox();
    const previous = { ...process.env };
    Object.assign(process.env, s.env);
    try {
      const request = await buildCliRequest(parseCliArgs(["--uninstall"]));
      expect(request.argv).toHaveLength(2);
      expect(request.argv[1]).toMatch(/\/uninstall\.sh$/);
    } finally {
      for (const key of Object.keys(s.env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key]!;
      }
    }
  });
});

/**
 * Running the file must raise exactly one dialog when a human asks for it, and none at
 * all under the test runner. `bun test` reports import.meta.main for every entry file it
 * loads; the forwarder shipped a bug of exactly this shape.
 */
describe("the CLI never raises a prompt by accident", () => {
  /** A PATH whose osascript records that it was called and does nothing else. */
  function stubOsascript(root: string): { binDir: string; called(): boolean } {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const marker = join(root, "osascript.called");
    writeFileSync(join(binDir, "osascript"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(join(binDir, "osascript"), 0o755);
    return { binDir, called: () => existsSync(marker) };
  }

  test("loading prompt.ts under bun test raises nothing", async () => {
    const s = await cliSandbox();
    const stub = stubOsascript(s.root);
    const spec = join(s.root, "loads-prompt.test.ts");
    writeFileSync(spec, `import { test, expect } from "bun:test";\nimport * as p from ${JSON.stringify(PROMPT_TS)};\ntest("loaded", () => expect(typeof p.cliMain).toBe("function"));\n`);

    const proc = Bun.spawn(["bun", "test", spec], {
      env: { ...process.env, ...s.env, PATH: `${stub.binDir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(0);
    expect(stub.called()).toBe(false);
  });

  test("--dry-run prints the command and never execs osascript", async () => {
    const s = await cliSandbox();
    const stub = stubOsascript(s.root);
    const proc = Bun.spawn(["bun", "run", PROMPT_TS, "--dry-run"], {
      env: { ...process.env, ...s.env, NODE_ENV: "production", PATH: `${stub.binDir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(stub.called()).toBe(false);
    const printed = JSON.parse(stdout);
    expect(printed.argv[1]).toMatch(/apply\.sh$/);
    expect(printed.env.LA_MANAGED_IPS).toBe(s.ips.join(" "));
  });

  test("a bad argument exits 2 without reaching osascript", async () => {
    const s = await cliSandbox();
    const stub = stubOsascript(s.root);
    const proc = Bun.spawn(["bun", "run", PROMPT_TS, "--nope"], {
      env: { ...process.env, ...s.env, NODE_ENV: "production", PATH: `${stub.binDir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(stub.called()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The root-agent model on the command line (docs/AGENT.md §1)
//
// One prompt at launch starts the agent; afterwards it watches desired-state.json and
// reconciles on its own. `--if-needed` is what makes that true for the CLI path too: with
// the agent up there is nothing for a prompt to do, so no dialog is raised at all.
// ---------------------------------------------------------------------------

/** A PATH whose osascript records that it was called and does nothing else. */
function stubOsascriptIn(root: string): { binDir: string; called(): boolean } {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(root, "osascript.called");
  writeFileSync(
    join(binDir, "osascript"),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(marker)}\nprintf 'LA_RESULT status=ok\\n'\nexit 0\n`,
  );
  chmodSync(join(binDir, "osascript"), 0o755);
  return { binDir, called: () => existsSync(marker) };
}

/** A process we own, so signal 0 has something real to find. Killed by PID, never by name. */
function spawnIdleProcess(): { pid: number; stop(): void } {
  const proc = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  return { pid: proc.pid, stop: () => proc.kill() };
}

describe("agentIsRunning", () => {
  test("no status file, unreadable JSON and a nonsense pid are all 'not running'", async () => {
    const root = mkdtempSync(join(tmpdir(), "la-agent-probe-"));
    expect(await agentIsRunning(join(root, "missing.json"))).toBe(false);

    const bad = join(root, "bad.json");
    writeFileSync(bad, "{not json");
    expect(await agentIsRunning(bad)).toBe(false);

    for (const pid of [0, 1, -5, 2.5, "123", null]) {
      const path = join(root, "pid.json");
      writeFileSync(path, JSON.stringify({ pid }));
      expect(await agentIsRunning(path)).toBe(false);
    }
  });

  test("our own pid is not evidence of an agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "la-agent-probe-"));
    const path = join(root, "self.json");
    writeFileSync(path, JSON.stringify({ pid: process.pid }));
    expect(await agentIsRunning(path)).toBe(false);
  });

  test("a live pid is running; the same pid once it has exited is not", async () => {
    const root = mkdtempSync(join(tmpdir(), "la-agent-probe-"));
    const path = join(root, "status.json");
    const idle = spawnIdleProcess();
    try {
      writeFileSync(path, JSON.stringify({ pid: idle.pid }));
      expect(await agentIsRunning(path)).toBe(true);
    } finally {
      idle.stop();
    }
    // Reaped, so the pid is gone. A stale status file must not read as a running agent.
    await Bun.sleep(150);
    expect(await agentIsRunning(path)).toBe(false);
  });
});

describe("--if-needed: no prompt while the agent is up", () => {
  test("it is parsed, and off unless asked for", () => {
    expect(parseCliArgs([]).ifNeeded).toBe(false);
    expect(parseCliArgs(["--if-needed"])).toMatchObject({ action: "apply", ifNeeded: true });
  });

  test("with the agent running, nothing is elevated and the CLI says why", async () => {
    const s = await cliSandbox();
    const stub = stubOsascriptIn(s.root);
    const idle = spawnIdleProcess();
    try {
      writeFileSync(
        join(s.env.LA_CONFIG_DIR!, "forwarder-status.json"),
        JSON.stringify({ pid: idle.pid, startedAt: new Date().toISOString(), routes: [], failures: [] }),
      );
      const proc = Bun.spawn(["bun", "run", PROMPT_TS, "--if-needed"], {
        env: { ...process.env, ...s.env, NODE_ENV: "production", PATH: `${stub.binDir}:${process.env.PATH}` },
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(code).toBe(0);
      expect(stdout).toContain("reason=agent-running");
      expect(stdout).toContain("prompt=skipped");
      expect(stub.called()).toBe(false); // THE point: no dialog, not even a prepared one
    } finally {
      idle.stop();
    }
  });

  test("with no agent, --if-needed still raises the one prompt: the manual path survives", async () => {
    const s = await cliSandbox();
    const stub = stubOsascriptIn(s.root);
    // A status file left behind by a crashed agent must not suppress the prompt.
    writeFileSync(
      join(s.env.LA_CONFIG_DIR!, "forwarder-status.json"),
      JSON.stringify({ pid: 2_147_483_6, startedAt: new Date().toISOString(), routes: [], failures: [] }),
    );
    const proc = Bun.spawn(["bun", "run", PROMPT_TS, "--if-needed"], {
      env: { ...process.env, ...s.env, NODE_ENV: "production", PATH: `${stub.binDir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(0);
    expect(stub.called()).toBe(true);
  });

  test("an uninstall ignores --if-needed: root must stop the agent, not ask it nicely", async () => {
    const s = await cliSandbox();
    const stub = stubOsascriptIn(s.root);
    const idle = spawnIdleProcess();
    try {
      writeFileSync(
        join(s.env.LA_CONFIG_DIR!, "forwarder-status.json"),
        JSON.stringify({ pid: idle.pid, startedAt: new Date().toISOString(), routes: [], failures: [] }),
      );
      const proc = Bun.spawn(["bun", "run", PROMPT_TS, "uninstall", "--if-needed"], {
        env: { ...process.env, ...s.env, NODE_ENV: "production", PATH: `${stub.binDir}:${process.env.PATH}` },
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(code).toBe(0);
      expect(stub.called()).toBe(true);
    } finally {
      idle.stop();
    }
  });
});
