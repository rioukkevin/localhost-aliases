/**
 * The two new endpoints, at the HTTP boundary the browser actually reaches.
 *
 * The service-level behaviour is covered in offline.test.ts and launch-at-login.test.ts;
 * this is about the wire: the right status codes, no caching of a live machine reading,
 * and a bad body rejected as a 400 rather than a 500.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createAlias } from "@localhost-aliases/core";
import { GET as offlineGet } from "../app/api/offline/route.ts";
import { GET as launchGet, PUT as launchPut } from "../app/api/launch-at-login/route.ts";
import { loginItemPath } from "../lib/launch-at-login.ts";
import { clearStackCache } from "../lib/stack-hints.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let box: Sandbox;

beforeEach(async () => {
  box = await sandbox();
  await mkdir(box.configDir, { recursive: true });
  clearStackCache();
});
afterEach(() => box.cleanup());

const get = (url: string) => new Request(url);
const put = (body: unknown) =>
  new Request("http://127.0.0.1:7788/api/launch-at-login", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

describe("GET /api/offline", () => {
  test("answers 200 with the alias, and never lets a browser cache it", async () => {
    await createAlias({ name: "shop", port: 3000 });
    const res = await offlineGet(get("http://127.0.0.1:7788/api/offline?host=shop.test"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.known).toBe(true);
    expect((body.alias as Record<string, unknown>).targetPort).toBe(3000);
    // The probe is real here — nothing is listening on a port we never bound.
    expect(body.listening).toBe(false);
  });

  test("a missing or unknown host is a 200 saying so, not a 404 the agent cannot render", async () => {
    for (const url of [
      "http://127.0.0.1:7788/api/offline",
      "http://127.0.0.1:7788/api/offline?host=",
      "http://127.0.0.1:7788/api/offline?host=nothing.test",
    ]) {
      const res = await offlineGet(get(url));
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).known).toBe(false);
    }
  });

  test("a hostile query string is normalised away rather than echoed back", async () => {
    const res = await offlineGet(
      get("http://127.0.0.1:7788/api/offline?host=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hostname).toBe("");
    expect(body.known).toBe(false);
  });
});

describe("/api/launch-at-login", () => {
  test("GET with nothing written yet is 200 unknown — not 404, not false", async () => {
    const res = await launchGet(get("http://127.0.0.1:7788/api/launch-at-login"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("unknown");
  });

  test("GET reflects whatever the menu-bar app last wrote", async () => {
    await writeFile(
      loginItemPath(),
      JSON.stringify({ status: "enabled", enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const body = (await (await launchGet(get("http://127.0.0.1:7788/api/launch-at-login"))).json()) as Record<
      string,
      unknown
    >;
    expect(body.status).toBe("enabled");
    expect(body.enabled).toBe(true);
    expect(body.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("PUT records the ask and reports it as pending, never as done", async () => {
    const body = (await (await launchPut(put({ action: "enable" }))).json()) as Record<string, unknown>;
    expect(body.pending).toBe(true);
    expect(body.requested).toBe("enable");
    expect(body.status).toBe("unknown");
    expect(body.enabled).toBeNull();
  });

  test("PUT without a known action is a 400 with a field, not a 500", async () => {
    for (const bad of [{}, { action: "yes" }, { action: 1 }, { action: null }, { enabled: true }]) {
      const res = await launchPut(put(bad));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues?: Array<{ field: string }> };
      expect(body.issues?.[0]?.field).toBe("action");
    }
  });
});
