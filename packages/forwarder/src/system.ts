/**
 * The agent's hands: the only code in this package that changes the machine.
 *
 * It is an interface first and an implementation second, on purpose. Every test injects a
 * recording fake, so the whole reconciliation logic is exercised without a single ifconfig
 * running and without /etc/hosts ever being opened for writing. `realSystem()` is
 * constructed in exactly one place — main() in index.ts, as root, at runtime.
 *
 * Binaries are pinned to absolute paths (with LA_* overrides mirroring lib.sh) so a PATH the
 * agent inherited from somewhere cannot substitute its own `ifconfig`.
 */
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HOSTS_PATH } from "@localhost-aliases/core/paths";
import { isPoolIp, parseLoopbackIps } from "@localhost-aliases/core/ips";
import { type Logger, silentLog } from "./log.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner. Nothing else in this package spawns. */
export type Exec = (argv: readonly string[]) => Promise<ExecResult>;

/**
 * Everything the agent may do to the machine. Deliberately tiny: four verbs, no "run this
 * command for me" escape hatch, so a reviewer can see the entire privileged surface here.
 */
export interface SystemOps {
  /** Every IPv4 currently on lo0, ours or not. */
  listLoopbackIps(): Promise<string[]>;
  /** Add a POOL address to lo0. Must reject anything else. */
  addLoopbackIp(ip: string): Promise<void>;
  /** Remove a POOL address from lo0. Must reject anything else. */
  removeLoopbackIp(ip: string): Promise<void>;
  readHosts(): Promise<string>;
  /** Replace the hosts file atomically. The caller has already proved the diff is safe. */
  writeHosts(content: string): Promise<void>;
  flushDns(): Promise<void>;
}

export interface RealSystemOptions {
  hostsPath?: string;
  exec?: Exec;
  log?: Logger;
}

const IFCONFIG = process.env.LA_IFCONFIG ?? "/sbin/ifconfig";
const DSCACHEUTIL = process.env.LA_DSCACHEUTIL ?? "/usr/bin/dscacheutil";
const KILLALL = process.env.LA_KILLALL ?? "/usr/bin/killall";

const spawnExec: Exec = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * The pool guard lives here as well as in desired.ts. Duplication is intentional: this is
 * the last line before `ifconfig`, and it must hold even if a future caller forgets to
 * validate. 127.0.0.1 is not in the pool, so it can never be touched by either verb.
 */
function assertPool(ip: string, verb: string): void {
  if (!isPoolIp(ip)) {
    throw new Error(`refusing to ${verb} ${JSON.stringify(ip)}: it is outside 127.0.0.2-254`);
  }
}

export function realSystem(options: RealSystemOptions = {}): SystemOps {
  const hostsPath = options.hostsPath ?? HOSTS_PATH;
  const exec = options.exec ?? spawnExec;
  const log = options.log ?? silentLog;

  const run = async (argv: readonly string[], what: string): Promise<ExecResult> => {
    const result = await exec(argv);
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  };

  return {
    async listLoopbackIps() {
      const { stdout } = await run([IFCONFIG, "lo0"], "ifconfig lo0");
      return parseLoopbackIps(stdout);
    },

    async addLoopbackIp(ip) {
      assertPool(ip, "add");
      await run([IFCONFIG, "lo0", "alias", ip, "netmask", "255.255.255.255", "up"], `ifconfig lo0 alias ${ip}`);
      log(`added ${ip} to lo0`);
    },

    async removeLoopbackIp(ip) {
      assertPool(ip, "remove");
      await run([IFCONFIG, "lo0", "-alias", ip], `ifconfig lo0 -alias ${ip}`);
      log(`removed ${ip} from lo0`);
    },

    async readHosts() {
      return Bun.file(hostsPath).text();
    },

    /**
     * Temp file in the same directory, 0644, then rename(2). Same directory because rename
     * is only atomic within one filesystem; a reader therefore sees the old file or the new
     * one, never a half-written /etc/hosts.
     */
    async writeHosts(content) {
      const dir = dirname(hostsPath);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${basename(hostsPath)}.la-agent.${process.pid}.tmp`);
      try {
        await writeFile(tmp, content, "utf8");
        await chmod(tmp, 0o644);
        await rename(tmp, hostsPath);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      log(`rewrote ${hostsPath}`);
    },

    /** Best effort by design: a stale DNS cache is a nuisance, not a reason to fail. */
    async flushDns() {
      try {
        await run([DSCACHEUTIL, "-flushcache"], "dscacheutil -flushcache");
      } catch (err) {
        log(`dscacheutil -flushcache failed (continuing): ${(err as Error).message}`);
      }
      try {
        // By exact process name. Never a pattern, and never anything else.
        await run([KILLALL, "-HUP", "mDNSResponder"], "killall -HUP mDNSResponder");
      } catch (err) {
        log(`mDNSResponder was not signalled (continuing): ${(err as Error).message}`);
      }
    },
  };
}
