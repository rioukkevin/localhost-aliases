/**
 * Observing the live machine WITHOUT privileges.
 *
 * Three unprivileged reads: `ifconfig lo0` (read-only, it changes nothing), the managed
 * block of /etc/hosts (world-readable), and forwarder-status.json (written by the root
 * forwarder for exactly this purpose). Nothing here mutates anything, and nothing here
 * may ever run a privileged command.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  HOSTS_PATH,
  diffDesiredState,
  forwarderStatusPath,
  parseBlock,
  parseLoopbackIps,
  type DesiredState,
  type ForwarderStatus,
  type HostsEntry,
  type StateDiff,
  type SystemState,
} from "@localhost-aliases/core";
import { readJsonOrNull, readTextOrNull } from "./files.ts";

const execFileAsync = promisify(execFile);

/** Absolute path so PATH cannot decide which binary we read state with. */
const IFCONFIG = "/sbin/ifconfig";
const IFCONFIG_TIMEOUT_MS = 3_000;

/** Resolved per call: tests point LA_HOSTS_PATH at a temp file. */
function hostsPath(): string {
  return process.env.LA_HOSTS_PATH ?? HOSTS_PATH;
}

/**
 * The three raw reads, injectable so unit tests never touch the real machine.
 * Every one of them fails soft: an unreadable source is reported as "nothing there",
 * which surfaces as drift rather than as a crashed dashboard.
 */
export interface SystemProbes {
  ifconfigLo0(): Promise<string>;
  hostsFile(): Promise<string>;
  forwarderStatus(): Promise<ForwarderStatus | null>;
  pidAlive(pid: number): boolean;
}

export const defaultProbes: SystemProbes = {
  async ifconfigLo0() {
    try {
      const { stdout } = await execFileAsync(IFCONFIG, ["lo0"], { timeout: IFCONFIG_TIMEOUT_MS });
      return stdout;
    } catch {
      return "";
    }
  },
  async hostsFile() {
    return (await readTextOrNull(hostsPath())) ?? "";
  },
  async forwarderStatus() {
    return readJsonOrNull<ForwarderStatus>(forwarderStatusPath());
  },
  pidAlive,
};

/**
 * Signal 0 only tests for existence; it never touches the process. The forwarder runs
 * as root, so a live one answers EPERM rather than success.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isForwarderStatus(value: unknown): value is ForwarderStatus {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<ForwarderStatus>;
  return typeof s.pid === "number" && Array.isArray(s.routes);
}

/** Everything read off the machine in one pass, before any comparison. */
export interface Observation {
  loopbackIps: string[];
  /** Managed /etc/hosts entries with their IPs — more than SystemState can carry. */
  hostsEntries: HostsEntry[];
  forwarder: ForwarderStatus | null;
  /** A status file whose process is gone. The forwarder counts as not running. */
  staleStatus: boolean;
}

export async function observe(probes: SystemProbes = defaultProbes): Promise<Observation> {
  const [ifconfigOut, hostsText, rawStatus] = await Promise.all([
    probes.ifconfigLo0(),
    probes.hostsFile(),
    probes.forwarderStatus(),
  ]);

  const status = isForwarderStatus(rawStatus) ? rawStatus : null;
  const alive = status !== null && probes.pidAlive(status.pid);

  return {
    loopbackIps: parseLoopbackIps(ifconfigOut),
    hostsEntries: parseBlock(hostsText),
    forwarder: alive ? { ...status, failures: status.failures ?? [] } : null,
    staleStatus: status !== null && !alive,
  };
}

/**
 * Hosts drift core cannot see: SystemState.managedHosts carries hostnames only, so a
 * line pointing the right hostname at the wrong IP is invisible to diffDesiredState.
 * We have the IPs here, so we report it.
 */
function hostsIpMismatches(observation: Observation, desired: DesiredState): string[] {
  const live = new Map(observation.hostsEntries.map((e) => [e.hostname, e.ip]));
  const reasons: string[] = [];
  for (const want of desired.hosts) {
    const have = live.get(want.hostname);
    if (have !== undefined && have !== want.ip) {
      reasons.push(`/etc/hosts points ${want.hostname} at ${have}, expected ${want.ip}.`);
    }
  }
  return reasons;
}

function withExtraDrift(diff: StateDiff, extraPrivileged: readonly string[]): StateDiff {
  if (extraPrivileged.length === 0) return diff;
  const privileged = [...diff.privileged, ...extraPrivileged];
  return {
    privileged,
    unprivileged: diff.unprivileged,
    drift: [...privileged, ...diff.unprivileged],
    needsPrompt: privileged.length > 0,
    applied: false,
  };
}

export interface LiveState {
  system: SystemState;
  diff: StateDiff;
  observation: Observation;
}

/** Compare an observation with the desired state and assemble SystemState. */
export function compare(observation: Observation, desired: DesiredState | null): LiveState {
  const base: SystemState = {
    loopbackIps: observation.loopbackIps,
    managedHosts: observation.hostsEntries.map((e) => e.hostname),
    forwarder: observation.forwarder,
    applied: true,
    drift: [],
  };

  const extra: string[] = [];
  if (observation.staleStatus) {
    extra.push("The forwarder left a status file behind but its process is gone.");
  }
  if (desired) extra.push(...hostsIpMismatches(observation, desired));

  const diff = withExtraDrift(
    desired
      ? diffDesiredState(desired, base)
      : { privileged: [], unprivileged: [], drift: [], needsPrompt: false, applied: true },
    extra,
  );

  return {
    system: { ...base, applied: diff.applied, drift: diff.drift },
    diff,
    observation,
  };
}

/** Read the machine and compare it with `desired` in one call. */
export async function readSystemState(
  desired: DesiredState | null,
  probes: SystemProbes = defaultProbes,
): Promise<LiveState> {
  return compare(await observe(probes), desired);
}
