/** A fetch stub: records requests and replays scripted responses. No socket is opened. */
import type { AliasView, Project } from "@localhost-aliases/core/types";
import type { FetchLike } from "../src/client.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface StubRoute {
  status?: number;
  body?: unknown;
  /** Raw body wins over `body`, for non-JSON responses. */
  raw?: string;
  /** Simulate a connection failure. */
  networkError?: boolean;
}

export function stubFetch(routes: Record<string, StubRoute>): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(input).pathname;
    requests.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response("not found", { status: 404 });
    if (route.networkError) throw new TypeError("Unable to connect. Is the computer able to access the url?");
    const status = route.status ?? 200;
    const text = route.raw ?? JSON.stringify(route.body ?? {});
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, requests };
}

export function alias(overrides: Partial<AliasView> = {}): AliasView {
  const name = overrides.name ?? "myapp";
  return {
    id: overrides.id ?? `id-${name}`,
    name,
    port: 3000,
    ip: "127.0.0.2",
    projectPath: null,
    description: null,
    enabled: true,
    reserved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hostname: `${name}.local`,
    url: `http://${name}.local`,
    status: "down",
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    path: "/Users/dev/app",
    name: "app",
    hasWorkspaceFile: false,
    aliases: [],
    ...overrides,
  };
}
