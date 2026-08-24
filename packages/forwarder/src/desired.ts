/**
 * Reading desired-state.json inside the ROOT agent.
 *
 * THIS FILE IS THE SECURITY BOUNDARY. desired-state.json is written by an unprivileged
 * process and acted on by a root one, so every field is treated as hostile — not as
 * "probably what the dashboard wrote". The agent re-derives everything it is about to do
 * from this function's output and nothing else.
 *
 * The rule is all-or-nothing: one bad entry rejects the WHOLE file. A per-entry skip would
 * let an attacker delete an alias (and its /etc/hosts line) by appending a malformed one,
 * and it would make a truncated write look like a legitimate "remove everything". A
 * rejected file leaves the previous system state exactly as it was.
 *
 * The one exception is `hint`, which is advisory by contract (types.ts: "nothing depends on
 * it being present or being right") and never reaches a privileged call — it is HTML-escaped
 * onto the offline page. An unusable hint is dropped with a warning rather than costing the
 * user their aliases.
 */
import type { Route } from "@localhost-aliases/core/types";
import { isValidHostname, type HostsEntry } from "@localhost-aliases/core/hosts";
import { isPoolIp, isValidIpv4 } from "@localhost-aliases/core/ips";

/** Same ceiling apply.sh enforces. A file with more entries than this is not a real config. */
export const MAX_ENTRIES = 512;

/** Hint fields are rendered, not executed, but they still get a ceiling and a charset. */
const MAX_FRAMEWORK = 64;
const MAX_COMMAND = 200;

/** C0 controls and DEL. Filtered out of hints so they cannot mangle the offline page. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Names that belong to the system part of /etc/hosts. Mirrors the case list in
 * packages/privileged/lib.sh; managing one of them would break name resolution for
 * everything on the machine.
 */
function isSystemHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "broadcasthost" ||
    hostname === "local" ||
    hostname.startsWith("localhost.") ||
    hostname.endsWith(".localhost")
  );
}

/**
 * 127.0.0.0/8. A route's bind address may be any loopback address — the tests bind
 * 127.0.0.1 on a high port, which is the only way to exercise a root component without
 * root — but never a routable interface: binding 0.0.0.0 or the machine's LAN address
 * would put the user's dev server on the network.
 *
 * Loopback is necessary but NOT sufficient: see the privileged-port rule in `parseDesiredState`,
 * which additionally confines ports <= 1024 to the 127.0.0.2-254 pool.
 */
export function isLoopbackIpv4(ip: unknown): ip is string {
  return typeof ip === "string" && isValidIpv4(ip) && ip.startsWith("127.");
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The highest port an unprivileged process may bind on macOS. Above this, binding is a
 * capability the user already has; at or below it, only root can, which is exactly the
 * capability this agent must not hand out (see `routes` validation below).
 */
export const LAST_PRIVILEGED_PORT = 1024;

/** What the agent is allowed to do, after validation. Nothing else is ever acted on. */
export interface SafePlan {
  /** Managed /etc/hosts entries, in file order. */
  hosts: HostsEntry[];
  /** Pool addresses that must exist on lo0. */
  loopbackIps: string[];
  /** Listeners the forwarder should own. */
  routes: Route[];
}

export interface PlanResult {
  /** Null exactly when `errors` is non-empty. */
  plan: SafePlan | null;
  /** Why the file was refused, in the order the problems were found. */
  errors: string[];
  /** Things dropped from an otherwise-usable file. */
  warnings: string[];
}

function refuse(...errors: string[]): PlanResult {
  return { plan: null, errors, warnings: [] };
}

/** `{ framework, command }`, or nothing plus a reason. Never throws. */
function readHint(raw: unknown, where: string): { hint: Route["hint"]; warning: string | null } {
  if (raw === undefined || raw === null) return { hint: undefined, warning: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { hint: undefined, warning: `${where}: hint is not an object; ignored` };
  }
  const { framework, command } = raw as { framework?: unknown; command?: unknown };
  if (typeof framework !== "string" || typeof command !== "string") {
    return { hint: undefined, warning: `${where}: hint needs a string framework and command; ignored` };
  }
  if (framework.length > MAX_FRAMEWORK || command.length > MAX_COMMAND) {
    return { hint: undefined, warning: `${where}: hint is too long; ignored` };
  }
  if (CONTROL_CHARS.test(framework) || CONTROL_CHARS.test(command)) {
    return { hint: undefined, warning: `${where}: hint contains control characters; ignored` };
  }
  return { hint: { framework, command }, warning: null };
}

/**
 * Parse and validate desired-state.json. Pure: it reads nothing and changes nothing, so it
 * can be exhaustively tested against hostile input without a machine to break.
 */
export function parseDesiredState(text: string): PlanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return refuse(`desired state is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("desired state must be a JSON object");
  }

  const { hosts, loopbackIps, routes } = raw as Record<string, unknown>;
  if (!Array.isArray(loopbackIps)) return refuse("loopbackIps is missing or not an array");
  if (!Array.isArray(hosts)) return refuse("hosts is missing or not an array");
  if (!Array.isArray(routes)) return refuse("routes is missing or not an array");
  if (loopbackIps.length > MAX_ENTRIES) return refuse(`loopbackIps has more than ${MAX_ENTRIES} entries`);
  if (hosts.length > MAX_ENTRIES) return refuse(`hosts has more than ${MAX_ENTRIES} entries`);
  if (routes.length > MAX_ENTRIES) return refuse(`routes has more than ${MAX_ENTRIES} entries`);

  const errors: string[] = [];
  const warnings: string[] = [];

  // --- loopbackIps: the pool, and only the pool ---------------------------
  // 127.0.0.1 fails isPoolIp, so it can never be added to (or removed from) lo0 here.
  const wantedIps: string[] = [];
  loopbackIps.forEach((entry, i) => {
    if (typeof entry !== "string" || !isPoolIp(entry)) {
      errors.push(`loopbackIps.${i} is ${JSON.stringify(entry)}, which is outside 127.0.0.2-254`);
      return;
    }
    if (wantedIps.includes(entry)) {
      errors.push(`loopbackIps lists ${entry} twice`);
      return;
    }
    wantedIps.push(entry);
  });

  // --- hosts: what goes inside the /etc/hosts markers ----------------------
  const safeHosts: HostsEntry[] = [];
  const seenHostnames = new Set<string>();
  hosts.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`hosts.${i} is not an object`);
      return;
    }
    const { ip, hostname } = entry as { ip?: unknown; hostname?: unknown };
    if (typeof ip !== "string" || !isPoolIp(ip)) {
      errors.push(`hosts.${i} points at ${JSON.stringify(ip)}, which is outside 127.0.0.2-254`);
      return;
    }
    // isValidHostname is what rejects whitespace, '#', newlines, over-long labels and
    // empty labels — i.e. everything that could smuggle a second /etc/hosts line.
    if (typeof hostname !== "string" || !isValidHostname(hostname)) {
      errors.push(`hosts.${i} has an invalid hostname ${JSON.stringify(hostname)}`);
      return;
    }
    if (isSystemHostname(hostname)) {
      errors.push(`hosts.${i} tries to manage ${JSON.stringify(hostname)}, which belongs to the system`);
      return;
    }
    if (seenHostnames.has(hostname)) {
      errors.push(`hosts lists ${hostname} twice`);
      return;
    }
    if (!wantedIps.includes(ip)) {
      errors.push(`hosts.${i} uses ${ip}, which is not in loopbackIps`);
      return;
    }
    seenHostnames.add(hostname);
    safeHosts.push({ ip, hostname });
  });

  // --- routes: what the forwarder binds -----------------------------------
  const safeRoutes: Route[] = [];
  const seenKeys = new Set<string>();
  routes.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`routes.${i} is not an object`);
      return;
    }
    const r = entry as Record<string, unknown>;
    if (!isLoopbackIpv4(r.ip)) {
      errors.push(`routes.${i} binds ${JSON.stringify(r.ip)}, which is not a loopback address`);
      return;
    }
    // A route may only bind a pool address the same file asks us to create. Otherwise a
    // hostile file could make root hold a privileged port on an address nobody allocated.
    if (isPoolIp(r.ip) && !wantedIps.includes(r.ip)) {
      errors.push(`routes.${i} binds ${r.ip}, which is not in loopbackIps`);
      return;
    }
    if (!isPort(r.listenPort)) {
      errors.push(`routes.${i} has an invalid listenPort ${JSON.stringify(r.listenPort)}`);
      return;
    }
    // THE PRIVILEGED-PORT RULE. Binding <=1024 is the one thing root can do here that the
    // user cannot do for themselves, so it is confined to the product's actual shape: a
    // pool address, 127.0.0.2-254, that this same file also asks us to put on lo0. Without
    // this, a hostile desired state makes root hold 127.0.0.1:22 (or :80, :443, :631) and
    // splice it to any high port the attacker is already listening on — a local user
    // hijacking the real localhost's privileged ports through us.
    //
    // Off-pool loopback (i.e. 127.0.0.1) stays legal above 1024 because that is how a root
    // component is exercised without root; above 1024 it grants nothing the caller lacks.
    if (r.listenPort <= LAST_PRIVILEGED_PORT && !isPoolIp(r.ip)) {
      errors.push(
        `routes.${i} asks root to bind the privileged port ${r.ip}:${r.listenPort}; ` +
          `only pool addresses (127.0.0.2-254) may hold a port at or below ${LAST_PRIVILEGED_PORT}`,
      );
      return;
    }
    if (!isPort(r.targetPort)) {
      errors.push(`routes.${i} has an invalid targetPort ${JSON.stringify(r.targetPort)}`);
      return;
    }
    if (typeof r.hostname !== "string" || !isValidHostname(r.hostname)) {
      errors.push(`routes.${i} has an invalid hostname ${JSON.stringify(r.hostname)}`);
      return;
    }
    const key = `${r.ip}:${r.listenPort}`;
    if (seenKeys.has(key)) {
      errors.push(`routes.${i} duplicates ${key}`);
      return;
    }
    seenKeys.add(key);

    const { hint, warning } = readHint(r.hint, `routes.${i}`);
    if (warning) warnings.push(warning);
    const route: Route = {
      ip: r.ip,
      listenPort: r.listenPort,
      targetPort: r.targetPort,
      hostname: r.hostname,
    };
    if (hint) route.hint = hint;
    safeRoutes.push(route);
  });

  if (errors.length > 0) return { plan: null, errors, warnings };
  return { plan: { hosts: safeHosts, loopbackIps: wantedIps, routes: safeRoutes }, errors, warnings };
}
