/**
 * The routing table and the ApplyRequest gate.
 *
 * Two jobs, both pure except for the table swap:
 *  - turn a `Host` header into a lookup key, and that key into a `Route`;
 *  - refuse an `ApplyRequest` that does not survive re-validation.
 *
 * The gate exists because this process is root. The caller (the user-space web server)
 * has already validated everything, and we assume it is compromised anyway: nothing
 * reaches `/etc/hosts` or the forward target without passing core's `isValidHostname`
 * and the loopback-target allowlist here.
 */
import { LOOPBACK_TARGETS, isValidHostname, type ApplyRequest, type Route } from "@localhost-aliases/core";

/**
 * Normalises a `Host` header into a routing key: lowercase, port removed, trailing dot
 * removed, IPv6 brackets removed. Returns null when there is nothing usable.
 */
export function hostKey(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  let host = header.trim().toLowerCase();
  if (host === "") return null;
  if (host.startsWith("[")) {
    // "[::1]:8080" — the colons inside the brackets are part of the address.
    const close = host.indexOf("]");
    if (close === -1) return null;
    host = host.slice(1, close);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  host = host.replace(/\.+$/, ""); // "myapp.local." is the same name as "myapp.local"
  return host === "" ? null : host;
}

/**
 * The live route table. Swapping it is a single assignment, which is what lets an
 * `apply` that only changes routes take effect without rebinding any listener.
 */
export class RouteTable {
  private table = new Map<string, Route>();

  swap(routes: Route[]): void {
    const next = new Map<string, Route>();
    for (const route of routes) {
      const key = route.host.toLowerCase();
      // Core guarantees hostname uniqueness; if two ever collide the first one wins rather
      // than silently shadowing, and the apply log records the count mismatch.
      if (!next.has(key)) next.set(key, route);
    }
    this.table = next;
  }

  lookup(hostHeader: string | null | undefined): Route | null {
    const key = hostKey(hostHeader);
    if (key === null) return null;
    return this.table.get(key) ?? null;
  }

  hosts(): string[] {
    return [...this.table.keys()];
  }

  /** Every live route, in table order. Used by the 404 page. */
  list(): Route[] {
    return [...this.table.values()];
  }

  get size(): number {
    return this.table.size;
  }
}

// ---------------------------------------------------------------------------
// ApplyRequest re-validation
// ---------------------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Rejects the whole request on the first bad entry — a partial apply is worse than none. */
export function validateApplyRequest(body: unknown): Validated<ApplyRequest> {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  if (!validPort(body.httpPort)) return { ok: false, error: `httpPort must be an integer 1-65535, got ${JSON.stringify(body.httpPort)}` };
  if (!validPort(body.httpsPort)) return { ok: false, error: `httpsPort must be an integer 1-65535, got ${JSON.stringify(body.httpsPort)}` };
  if (!Array.isArray(body.routes)) return { ok: false, error: "routes must be an array" };

  const routes: Route[] = [];
  for (const [index, raw] of body.routes.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `routes[${index}] must be an object` };
    const host = typeof raw.host === "string" ? raw.host.trim().toLowerCase() : "";
    // The one check that matters: this string is about to become a line in /etc/hosts.
    if (!isValidHostname(host)) {
      return { ok: false, error: `routes[${index}].host ${JSON.stringify(raw.host)} is not a valid hostname` };
    }
    if (!validPort(raw.port)) {
      return { ok: false, error: `routes[${index}].port must be an integer 1-65535, got ${JSON.stringify(raw.port)}` };
    }
    const target = typeof raw.target === "string" ? raw.target.trim().toLowerCase() : "";
    // Defence in depth: a root process must never be turned into an open forward proxy.
    if (!(LOOPBACK_TARGETS as readonly string[]).includes(target)) {
      return {
        ok: false,
        error: `routes[${index}].target ${JSON.stringify(raw.target)} is not a loopback address (${LOOPBACK_TARGETS.join(", ")})`,
      };
    }
    routes.push({ host, target, port: raw.port, aliasId: typeof raw.aliasId === "string" ? raw.aliasId : "" });
  }

  let tls: ApplyRequest["tls"] = null;
  if (body.tls !== null && body.tls !== undefined) {
    if (!isRecord(body.tls) || typeof body.tls.cert !== "string" || typeof body.tls.key !== "string") {
      return { ok: false, error: "tls must be null or { cert: string, key: string }" };
    }
    if (body.tls.cert.trim() === "" || body.tls.key.trim() === "") {
      return { ok: false, error: "tls.cert and tls.key must not be empty" };
    }
    tls = { cert: body.tls.cert, key: body.tls.key };
  }

  return { ok: true, value: { httpPort: body.httpPort, httpsPort: body.httpsPort, routes, tls } };
}
