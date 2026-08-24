/**
 * The /offline page's data, in one read.
 *
 * When a dev server is not running, the root agent answers the alias itself with a small
 * inline 503 and links here with `?host=<hostname>`. That page has room for four things
 * the 503 does not:
 *
 *   - which alias this is, and the port it forwards to;
 *   - the exact command that starts THAT project on THAT port, when we recognise it;
 *   - what to check when the port is right but the server bound the wrong interface;
 *   - a live reading that flips the moment something answers, so the page is useful
 *     while you fix it rather than after.
 *
 * Everything here is read-only and unprivileged: the config, a folder, and one TCP
 * connect to 127.0.0.1. Nothing is started, nothing is written.
 */
import { hostnameFor, loadConfig, probePort, targetPortFor, type DetectedStack } from "@localhost-aliases/core";
import { stackForProject } from "./stack-hints.ts";

/** How long we wait for the dev server to accept a connection before calling it down. */
export const OFFLINE_PROBE_TIMEOUT_MS = 500;

export interface OfflineAlias {
  id: string;
  name: string;
  hostname: string;
  url: string;
  /** The port the forwarder splices to on 127.0.0.1 — what must be listening. */
  targetPort: number;
  ip: string;
  projectPath: string | null;
  enabled: boolean;
  reserved: boolean;
}

export interface OfflineView {
  /** The hostname asked about, normalised. Empty when the caller sent none. */
  hostname: string;
  /** False when no alias carries that hostname — a stale bookmark, or a renamed alias. */
  known: boolean;
  alias: OfflineAlias | null;
  /**
   * What we think starts this project, or null. Null is a real answer: the page says it
   * does not recognise the folder rather than printing a command that would not work.
   */
  stack: DetectedStack | null;
  /** True the moment something accepts a connection on 127.0.0.1:targetPort. */
  listening: boolean;
  checkedAt: string;
}

/** Injectable so a unit test never opens a socket. */
export interface OfflineDeps {
  probe(port: number): Promise<boolean>;
  now(): Date;
}

const defaultDeps: OfflineDeps = {
  probe: async (port) => (await probePort("127.0.0.1", port, OFFLINE_PROBE_TIMEOUT_MS)) === "up",
  now: () => new Date(),
};

/**
 * Accepts what a browser would actually put in the query string: the bare hostname, a
 * `host:port` authority, or a whole URL. Anything else normalises to "" and the page
 * says it was not told which alias to talk about.
 */
export function normaliseHost(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  let value = raw.trim().toLowerCase();
  if (value === "") return "";
  if (value.includes("://")) value = value.slice(value.indexOf("://") + 3);
  // Cut at the authority: a whole URL, a path, a query or a fragment all reduce to the
  // host, and anything left that is not hostname-shaped is refused outright below.
  value = value.split(/[/?#]/)[0] ?? "";
  // An IPv6 literal has no place here — aliases are names — but strip a port either way.
  const colon = value.lastIndexOf(":");
  if (colon > 0) value = value.slice(0, colon);
  return /^[a-z0-9.-]+$/.test(value) ? value.replace(/\.$/, "") : "";
}

export async function readOffline(
  rawHost: string | null | undefined,
  deps: OfflineDeps = defaultDeps,
): Promise<OfflineView> {
  const hostname = normaliseHost(rawHost);
  const checkedAt = deps.now().toISOString();
  if (hostname === "") {
    return { hostname: "", known: false, alias: null, stack: null, listening: false, checkedAt };
  }

  const config = await loadConfig();
  const found = config.aliases.find((a) => hostnameFor(a.name, config.tld) === hostname);
  if (!found) {
    return { hostname, known: false, alias: null, stack: null, listening: false, checkedAt };
  }

  const targetPort = targetPortFor(found, config);
  const [listening, stack] = await Promise.all([
    deps.probe(targetPort),
    stackForProject(found.projectPath, targetPort),
  ]);

  return {
    hostname,
    known: true,
    alias: {
      id: found.id,
      name: found.name,
      hostname,
      url: `http://${hostname}`,
      targetPort,
      ip: found.ip,
      projectPath: found.projectPath,
      enabled: found.enabled,
      reserved: found.reserved,
    },
    stack,
    listening,
    checkedAt: deps.now().toISOString(),
  };
}
