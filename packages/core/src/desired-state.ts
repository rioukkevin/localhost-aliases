/**
 * Desired state, and the diff that decides whether the user is prompted for their password.
 *
 * The whole UX hinges on one distinction:
 *   - hostname or IP changes  -> /etc/hosts and lo0 must change -> admin prompt
 *   - target port changes     -> the forwarder re-reads routes.json by itself -> no prompt
 */
import type { Alias, Config, DesiredState, Route, SystemState } from "./types.ts";
import { hostnameFor } from "./validation.ts";
import { isPoolIp } from "./ips.ts";

export const LISTEN_PORT = 80;

/** The port an alias actually forwards to: the dashboard alias mirrors dashboardPort. */
export function targetPortFor(alias: Alias, config: Config): number {
  return alias.reserved ? config.dashboardPort : alias.port;
}

export function buildDesiredState(config: Config): DesiredState {
  const active = config.aliases.filter((a) => a.enabled);
  const routes: Route[] = active.map((alias) => ({
    ip: alias.ip,
    listenPort: LISTEN_PORT,
    targetPort: targetPortFor(alias, config),
    hostname: hostnameFor(alias.name, config.tld),
  }));

  return {
    hosts: routes.map((r) => ({ ip: r.ip, hostname: r.hostname })),
    loopbackIps: [...new Set(routes.map((r) => r.ip))],
    routes,
  };
}

export interface StateDiff {
  /** Drift only root can fix: /etc/hosts, lo0 aliases, (re)starting the forwarder. */
  privileged: string[];
  /** Drift the running forwarder resolves on its own when routes.json changes. */
  unprivileged: string[];
  /** Everything, privileged first. Feeds SystemState.drift. */
  drift: string[];
  /** True when an admin prompt is required. */
  needsPrompt: boolean;
  /** True when nothing at all has drifted. */
  applied: boolean;
}

function formatList(items: readonly string[]): string {
  return items.join(", ");
}

/**
 * Compare desired state against what was actually observed on the machine.
 * `live` is null before anything has been probed, which counts as full drift.
 */
export function diffDesiredState(desired: DesiredState, live: SystemState | null): StateDiff {
  const privileged: string[] = [];
  const unprivileged: string[] = [];

  if (!live) {
    if (desired.loopbackIps.length > 0) privileged.push("System state has not been read yet.");
    return finish(privileged, unprivileged);
  }

  // --- lo0 --------------------------------------------------------------
  const liveIps = new Set(live.loopbackIps);
  const wantedIps = new Set(desired.loopbackIps);
  const missingIps = desired.loopbackIps.filter((ip) => !liveIps.has(ip));
  // Only pool addresses are ours; 127.0.0.1 and anything outside the pool is left alone.
  const staleIps = live.loopbackIps.filter((ip) => isPoolIp(ip) && !wantedIps.has(ip));
  if (missingIps.length > 0) {
    privileged.push(`Missing loopback ${plural(missingIps.length, "address")} on lo0: ${formatList(missingIps)}.`);
  }
  if (staleIps.length > 0) {
    privileged.push(`Stale loopback ${plural(staleIps.length, "address")} on lo0: ${formatList(staleIps)}.`);
  }

  // --- /etc/hosts -------------------------------------------------------
  const liveHosts = new Set(live.managedHosts);
  const wantedHosts = new Set(desired.hosts.map((h) => h.hostname));
  const missingHosts = [...wantedHosts].filter((h) => !liveHosts.has(h));
  const staleHosts = live.managedHosts.filter((h) => !wantedHosts.has(h));
  if (missingHosts.length > 0) {
    privileged.push(`Missing from /etc/hosts: ${formatList(missingHosts)}.`);
  }
  if (staleHosts.length > 0) {
    privileged.push(`Left over in /etc/hosts: ${formatList(staleHosts)}.`);
  }

  // --- forwarder --------------------------------------------------------
  const forwarder = live.forwarder;
  if (!forwarder) {
    if (desired.routes.length > 0) privileged.push("The forwarder is not running.");
    return finish(privileged, unprivileged);
  }

  const liveByHost = new Map(forwarder.routes.map((r) => [r.hostname, r]));
  for (const want of desired.routes) {
    const have = liveByHost.get(want.hostname);
    if (!have) {
      privileged.push(`${want.hostname} is not being forwarded.`);
      continue;
    }
    if (have.ip !== want.ip || have.listenPort !== want.listenPort) {
      privileged.push(
        `${want.hostname} is bound to ${have.ip}:${have.listenPort}, expected ${want.ip}:${want.listenPort}.`,
      );
      continue;
    }
    if (have.targetPort !== want.targetPort) {
      // Ports live in routes.json only: no hosts entry and no lo0 alias changes.
      unprivileged.push(
        `${want.hostname} now targets port ${want.targetPort} (was ${have.targetPort}); the forwarder reloads this itself.`,
      );
    }
  }

  const wantedHostnames = new Set(desired.routes.map((r) => r.hostname));
  for (const have of forwarder.routes) {
    if (!wantedHostnames.has(have.hostname)) {
      unprivileged.push(`${have.hostname} is still being forwarded; the forwarder drops it on reload.`);
    }
  }

  for (const failure of forwarder.failures) {
    privileged.push(`${failure.route.hostname} could not be bound: ${failure.error}`);
  }

  return finish(privileged, unprivileged);
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}es`;
}

function finish(privileged: string[], unprivileged: string[]): StateDiff {
  return {
    privileged,
    unprivileged,
    drift: [...privileged, ...unprivileged],
    needsPrompt: privileged.length > 0,
    applied: privileged.length === 0 && unprivileged.length === 0,
  };
}
