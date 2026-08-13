/**
 * Every test redirects LA_* at a fresh temp directory and stubs the three system reads,
 * so no test can touch /etc/hosts, lo0, ~/.config or a real client config.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesiredState, ForwarderStatus } from "@localhost-aliases/core";
import type { SystemProbes } from "../lib/system.ts";

export interface Sandbox {
  dir: string;
  configDir: string;
  hostsPath: string;
  cleanup(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "la-dashboard-"));
  const configDir = join(dir, "config");
  const hostsPath = join(dir, "hosts");

  process.env.LA_CONFIG_DIR = configDir;
  process.env.LA_HOSTS_PATH = hostsPath;
  process.env.LA_CLAUDE_CONFIG = join(dir, "claude.json");
  process.env.LA_CODEX_CONFIG = join(dir, "codex", "config.toml");
  process.env.LA_RUNTIME_ROOT = join(dir, "runtime");
  process.env.LA_LOG_DIR = join(dir, "logs");

  return {
    dir,
    configDir,
    hostsPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface StubInput {
  loopbackIps?: string[];
  hosts?: Array<{ ip: string; hostname: string }>;
  forwarder?: ForwarderStatus | null;
  pidAlive?: boolean;
}

const BEGIN = "# >>> localhost-aliases >>>";
const END = "# <<< localhost-aliases <<<";

export function stubProbes(input: StubInput = {}): SystemProbes {
  const ips = input.loopbackIps ?? [];
  const hosts = input.hosts ?? [];
  const block =
    hosts.length === 0
      ? ""
      : [BEGIN, ...hosts.map((h) => `${h.ip}\t${h.hostname}`), END, ""].join("\n");

  return {
    ifconfigLo0: async () =>
      ["lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384", ...ips.map((ip) => `\tinet ${ip} netmask 0xff000000`)].join("\n"),
    hostsFile: async () => `##\n# Host Database\n##\n127.0.0.1\tlocalhost\n${block}`,
    forwarderStatus: async () => input.forwarder ?? null,
    pidAlive: () => input.pidAlive ?? true,
  };
}

/** A forwarder status that matches a desired state exactly. */
export function forwarderFor(desired: DesiredState, pid = 4242): ForwarderStatus {
  return {
    pid,
    startedAt: new Date().toISOString(),
    routes: desired.routes,
    failures: [],
  };
}

/** Probes describing a machine where `desired` has been fully applied. */
export function appliedProbes(desired: DesiredState): SystemProbes {
  return stubProbes({
    loopbackIps: ["127.0.0.1", ...desired.loopbackIps],
    hosts: desired.hosts,
    forwarder: forwarderFor(desired),
  });
}
