import { describe, expect, test } from "bun:test";
import { DashboardApiError, DashboardClient, DashboardUnreachableError } from "../src/client.ts";
import { alias, stubFetch } from "./stub.ts";

const BASE = "http://127.0.0.1:7788";

function client(routes: Parameters<typeof stubFetch>[0]) {
  const { fetch, requests } = stubFetch(routes);
  return { client: new DashboardClient({ baseUrl: BASE, fetch }), requests };
}

describe("DashboardClient", () => {
  test("unwraps the documented envelope", async () => {
    const { client: c } = client({ "GET /api/aliases": { body: { aliases: [alias()] } } });
    expect((await c.listAliases()).map((a) => a.hostname)).toEqual(["myapp.local"]);
  });

  test("also accepts a bare array", async () => {
    const { client: c } = client({ "GET /api/aliases": { body: [alias({ name: "web" })] } });
    expect((await c.listAliases())[0]?.hostname).toBe("web.local");
  });

  test("returns an empty list when the shape is unrecognised", async () => {
    const { client: c } = client({ "GET /api/aliases": { body: { nope: 1 } } });
    expect(await c.listAliases()).toEqual([]);
  });

  test("POST sends JSON and unwraps the created alias", async () => {
    const { client: c, requests } = client({
      "POST /api/aliases": { status: 201, body: { alias: alias({ name: "api", port: 4000 }) } },
    });
    const created = await c.createAlias({ name: "api", port: 4000 });
    expect(created.alias.name).toBe("api");
    expect(requests[0]).toEqual({ method: "POST", path: "/api/aliases", body: { name: "api", port: 4000 } });
  });

  test("DELETE percent-encodes the id", async () => {
    const { client: c, requests } = client({ "DELETE /api/aliases/a%2Fb": { body: { ok: true } } });
    await c.deleteAlias("a/b");
    expect(requests[0]?.path).toBe("/api/aliases/a%2Fb");
  });

  test("a connection failure becomes DashboardUnreachableError", async () => {
    const { client: c } = client({ "GET /api/aliases": { networkError: true } });
    const error = await c.listAliases().catch((e) => e);
    expect(error).toBeInstanceOf(DashboardUnreachableError);
    expect(error.message).toContain("http://127.0.0.1:7788");
    expect(error.message).toContain("menu-bar app");
    expect(error.message).not.toContain("Unable to connect"); // no raw cause leaks out
  });

  test("an error status surfaces the API's message", async () => {
    const { client: c } = client({
      "POST /api/aliases": { status: 409, body: { error: "myapp is already taken" } },
    });
    const error = await c.createAlias({ name: "myapp", port: 3000 }).catch((e) => e);
    expect(error).toBeInstanceOf(DashboardApiError);
    expect(error.status).toBe(409);
    expect(error.message).toBe("myapp is already taken");
  });

  test("an error status surfaces ValidationError issues", async () => {
    const { client: c } = client({
      "POST /api/aliases": { status: 400, body: { issues: [{ field: "port", message: "out of range" }] } },
    });
    const error = await c.createAlias({ name: "x", port: 0 }).catch((e) => e);
    expect(error.message).toBe("port: out of range");
  });

  test("a non-JSON error body is still readable", async () => {
    const { client: c } = client({ "GET /api/aliases": { status: 500, raw: "boom" } });
    const error = await c.listAliases().catch((e) => e);
    expect(error.message).toBe("HTTP 500: boom");
  });

  test("carries the sync report back to the caller", async () => {
    const { client: c } = client({
      "POST /api/aliases": {
        status: 201,
        body: { alias: alias(), sync: { applied: false, needsPrompt: true, privileged: ["add 127.0.0.2 to lo0"] } },
      },
    });
    const { sync } = await c.createAlias({ name: "myapp", port: 3000 });
    expect(sync?.needsPrompt).toBe(true);
    expect(sync?.privileged).toEqual(["add 127.0.0.2 to lo0"]);
  });

  test("DELETE reports the id even when the body omits it", async () => {
    const { client: c } = client({ "DELETE /api/aliases/x": { raw: "" } });
    expect((await c.deleteAlias("x")).deleted).toBe("x");
  });

  test("POST /api/projects/link passes the whole body through", async () => {
    const { client: c, requests } = client({
      "POST /api/projects/link": { body: { project: { path: "/p", name: "p", hasWorkspaceFile: false, aliases: [] }, created: [], updated: [], workspaceFile: null } },
    });
    await c.linkProject({ path: "/p", aliasIds: ["a1"], importWorkspace: false, writeWorkspaceFile: true });
    expect(requests[0]?.body).toEqual({ path: "/p", aliasIds: ["a1"], importWorkspace: false, writeWorkspaceFile: true });
  });

  test("a trailing slash on the base url does not double up", async () => {
    const { fetch, requests } = stubFetch({ "GET /api/aliases": { body: { aliases: [] } } });
    await new DashboardClient({ baseUrl: `${BASE}/`, fetch }).listAliases();
    expect(requests[0]?.path).toBe("/api/aliases");
  });
});
