/**
 * Reading routes.json. The forwarder never trusts this file: it is written by an
 * unprivileged process and read by a root one, so every field is validated and a bad
 * entry is skipped rather than allowed to take the process down.
 */
import type { Route } from "@localhost-aliases/core/types";

export interface ParsedRoutes {
  routes: Route[];
  /** Human-readable reasons entries were rejected. Surfaced in the status file. */
  errors: string[];
}

/** `ip:listenPort` — the identity of a listener. Two routes may not share one. */
export function routeKey(route: Pick<Route, "ip" | "listenPort">): string {
  return `${route.ip}:${route.listenPort}`;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Accepts a bare `Route[]` or a `{ routes: Route[] }` wrapper (the desired-state shape). */
export function parseRoutes(text: string): ParsedRoutes {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { routes: [], errors: [`routes file is not valid JSON: ${(err as Error).message}`] };
  }

  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { routes?: unknown }).routes)
      ? ((raw as { routes: unknown[] }).routes)
      : null;
  if (!list) return { routes: [], errors: ["routes file must be an array of routes"] };

  const routes: Route[] = [];
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const r = entry as Partial<Route> | null;
    if (!r || typeof r !== "object") return void errors.push(`route ${i}: not an object`);
    if (!isIpv4(r.ip)) return void errors.push(`route ${i}: invalid ip ${JSON.stringify(r.ip)}`);
    if (!isPort(r.listenPort)) return void errors.push(`route ${i}: invalid listenPort ${JSON.stringify(r.listenPort)}`);
    if (!isPort(r.targetPort)) return void errors.push(`route ${i}: invalid targetPort ${JSON.stringify(r.targetPort)}`);
    const hostname = typeof r.hostname === "string" && r.hostname.length > 0 ? r.hostname : routeKey(r as Route);
    const key = routeKey(r as Route);
    if (seen.has(key)) return void errors.push(`route ${i}: duplicate ${key}, ignored`);
    seen.add(key);
    routes.push({ ip: r.ip, listenPort: r.listenPort, targetPort: r.targetPort, hostname });
  });

  return { routes, errors };
}

/** A missing routes file means "no routes", not an error: the app writes it when it has some. */
export async function readRoutes(path: string): Promise<ParsedRoutes> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { routes: [], errors: [] };
  }
  if (text.trim() === "") return { routes: [], errors: [] };
  return parseRoutes(text);
}
