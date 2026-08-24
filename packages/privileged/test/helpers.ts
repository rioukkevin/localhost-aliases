/**
 * A sandbox for driving the privileged scripts without ever touching the machine.
 *
 * Every command that would change the system — ifconfig, dscacheutil, killall — is a
 * stub on PATH (and pinned through the LA_* overrides, so even a PATH mistake cannot
 * reach the real binary). /etc/hosts is a file in a temp directory. The "forwarder" is
 * a script that sleeps; its pid is recorded and killed by pid, never by name.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PRIV_DIR = new URL("..", import.meta.url).pathname;
export const APPLY = join(PRIV_DIR, "apply.sh");
export const UNINSTALL = join(PRIV_DIR, "uninstall.sh");

export const SYSTEM_HOSTS = [
  "##",
  "# Host Database",
  "##",
  "127.0.0.1\tlocalhost",
  "255.255.255.255\tbroadcasthost",
  "::1             localhost",
  "",
].join("\n");

export interface Sandbox {
  root: string;
  configDir: string;
  logDir: string;
  hostsPath: string;
  binDir: string;
  forwarder: string;
  /** IPs the fake lo0 currently has. */
  lo0(): string[];
  setLo0(ips: string[]): void;
  /** argv lines each stub was called with. */
  calls(name: "ifconfig" | "dscacheutil" | "killall"): string[];
  hosts(): string;
  writeState(state: unknown): string;
  env(extra?: Record<string, string>): Record<string, string>;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "la-priv-"));
  const configDir = join(root, "config");
  const logDir = join(root, "logs");
  const binDir = join(root, "bin");
  const hostsPath = join(root, "etc", "hosts");
  for (const dir of [configDir, logDir, binDir, join(root, "etc")]) mkdirSync(dir, { recursive: true });
  writeFileSync(hostsPath, SYSTEM_HOSTS);

  const ipsFile = join(root, "lo0-ips");
  writeFileSync(ipsFile, "127.0.0.1\n");
  const callLog = (name: string) => join(root, `${name}.calls`);
  for (const name of ["ifconfig", "dscacheutil", "killall"]) writeFileSync(callLog(name), "");

  script(
    join(binDir, "ifconfig"),
    `printf '%s\\n' "$*" >> ${q(callLog("ifconfig"))}
case "\${2:-}" in
  alias)  grep -qx "$3" ${q(ipsFile)} || printf '%s\\n' "$3" >> ${q(ipsFile)} ;;
  -alias) grep -vx "$3" ${q(ipsFile)} > ${q(ipsFile)}.tmp || true; mv ${q(ipsFile)}.tmp ${q(ipsFile)} ;;
  *)
    printf 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\\n'
    while read -r ip; do printf '\\tinet %s netmask 0xff000000\\n' "$ip"; done < ${q(ipsFile)} ;;
esac
exit 0`,
  );
  script(join(binDir, "dscacheutil"), `printf '%s\\n' "$*" >> ${q(callLog("dscacheutil"))}\nexit 0`);
  script(join(binDir, "killall"), `printf '%s\\n' "$*" >> ${q(callLog("killall"))}\nexit 0`);

  // A stand-in forwarder: records that it started, publishes the status file the real
  // one publishes, then stays alive briefly. It never binds a socket.
  const forwarder = join(binDir, "forwarder");
  script(
    forwarder,
    `printf 'started config=%s log=%s\\n' "\${LA_CONFIG_DIR:-}" "\${LA_LOG_DIR:-}" >> ${q(join(root, "forwarder.calls"))}
printf '%s\\n' "$$" >> ${q(join(root, "pids"))}
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","routes":[],"failures":[]}\\n' "$$" > "\${LA_CONFIG_DIR}/forwarder-status.json"
sleep 5 &
wait`,
  );

  return {
    root,
    configDir,
    logDir,
    hostsPath,
    binDir,
    forwarder,
    lo0: () => readFileSync(ipsFile, "utf8").split("\n").filter(Boolean),
    setLo0: (ips) => writeFileSync(ipsFile, ips.map((i) => `${i}\n`).join("")),
    calls: (name) => readFileSync(callLog(name), "utf8").split("\n").filter(Boolean),
    hosts: () => readFileSync(hostsPath, "utf8"),
    writeState(state) {
      const path = join(root, "desired-state.json");
      writeFileSync(path, JSON.stringify(state));
      return path;
    },
    env(extra = {}) {
      return {
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LA_TEST_MODE: "1",
        LA_CONFIG_DIR: configDir,
        LA_LOG_DIR: logDir,
        LA_HOSTS_PATH: hostsPath,
        LA_FORWARDER: forwarder,
        LA_IFCONFIG: join(binDir, "ifconfig"),
        LA_DSCACHEUTIL: join(binDir, "dscacheutil"),
        LA_KILLALL: join(binDir, "killall"),
        ...extra,
      };
    },
  };
}

function q(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The parsed LA_RESULT line from stdout. */
  summary: Record<string, string>;
}

export async function run(argv: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const summary: Record<string, string> = {};
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("LA_RESULT")).pop();
  if (line) {
    for (const token of line.slice("LA_RESULT".length).trim().split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq > 0) summary[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }
  return { code, stdout, stderr, summary };
}

/**
 * Kill only pids this sandbox started, and only after proving the process really is the
 * sandbox's own stub. Nothing is ever matched by name or pattern.
 */
export function killSandboxProcesses(sandbox: Sandbox): void {
  const file = join(sandbox.root, "pids");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const cmd = commandOf(pid);
    if (cmd === null || !cmd.includes(sandbox.root)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  writeFileSync(file, "");
}

function commandOf(pid: number): string | null {
  const proc = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
}

export const STATE_TWO = {
  hosts: [
    { ip: "127.0.0.2", hostname: "index.test" },
    { ip: "127.0.0.3", hostname: "myapp.test" },
  ],
  loopbackIps: ["127.0.0.2", "127.0.0.3"],
  routes: [
    { ip: "127.0.0.2", listenPort: 80, targetPort: 7788, hostname: "index.test" },
    { ip: "127.0.0.3", listenPort: 80, targetPort: 3000, hostname: "myapp.test" },
  ],
};
