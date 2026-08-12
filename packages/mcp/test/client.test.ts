/**
 * The HTTP layer in isolation: every failure mode has to come back as a typed
 * result with a message a coding agent can act on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { fetchAliases, postAlias } from "../src/client.ts";
import { freePort } from "./fixtures/mcp-harness.ts";

let handler: (request: Request) => Response = () => new Response("{}");
let server: ReturnType<typeof Bun.serve>;
const previousPort = process.env.LA_DASHBOARD_PORT;

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) });
  process.env.LA_DASHBOARD_PORT = String(server.port);
});

afterAll(async () => {
  await server.stop(true);
  if (previousPort === undefined) delete process.env.LA_DASHBOARD_PORT;
  else process.env.LA_DASHBOARD_PORT = previousPort;
});

afterEach(() => {
  handler = () => new Response("{}");
});

function respond(body: unknown, status: number): void {
  handler = () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dashboard client", () => {
  test("a closed port becomes an actionable 'unreachable' result", async () => {
    const dead = await freePort();
    process.env.LA_DASHBOARD_PORT = String(dead);
    const result = await fetchAliases();
    process.env.LA_DASHBOARD_PORT = String(server.port);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("unreachable");
    expect(result.message).toContain("not reachable");
    expect(result.message).toContain("bun run dev");
    expect(result.message).toContain("LA_DASHBOARD_PORT");
  });

  test("200 unwraps the aliases array", async () => {
    respond({ aliases: [{ id: "a", name: "x", port: 3000 }] }, 200);
    const result = await fetchAliases();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
  });

  test("a 200 without the expected key degrades to an empty list", async () => {
    respond({}, 200);
    const result = await fetchAliases();
    expect(result.ok && result.data).toEqual([]);
  });

  test("400 keeps the field-level issues", async () => {
    respond({ error: "invalid", issues: [{ field: "port", message: "must be 1-65535" }] }, 400);
    const result = await postAlias({ name: "x", port: 99999 });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== "validation") return;
    expect(result.status).toBe(400);
    expect(result.issues[0]?.field).toBe("port");
  });

  test("404 and 500 are plain HTTP failures carrying the server's message", async () => {
    respond({ error: "no such alias" }, 404);
    const missing = await fetchAliases();
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.kind).toBe("http");
      expect(missing.message).toBe("no such alias");
    }

    respond({ error: "boom" }, 500);
    const broken = await fetchAliases();
    expect(broken.ok === false && broken.kind === "http" && broken.status).toBe(500);
  });

  test("a non-JSON error body still yields a readable message", async () => {
    handler = () => new Response("<html>502</html>", { status: 502 });
    const result = await fetchAliases();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("http");
    expect(result.message).toContain("502");
  });

  test("issues on a non-400 status are still treated as validation feedback", async () => {
    respond({ error: "conflict", issues: [{ field: "name", message: "already in use" }] }, 409);
    const result = await postAlias({ name: "dup", port: 3000 });
    expect(result.ok === false && result.kind).toBe("validation");
  });
});
