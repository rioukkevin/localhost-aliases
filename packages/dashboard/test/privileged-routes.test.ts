/**
 * The two endpoints, exercised as plain functions. The point is the contract the browser
 * sees: a refusal when no menu-bar app is listening, and a progress shape it can poll.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { applyRequestPath, applyResultPath, livenessPath } from "@localhost-aliases/core";
import { POST as requestRoute } from "../app/api/privileged/request/route.ts";
import { GET as progressRoute } from "../app/api/privileged/progress/route.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let box: Sandbox;

beforeEach(async () => {
  box = await sandbox();
  await mkdir(box.configDir, { recursive: true });
});
afterEach(() => box.cleanup());

const post = (body: unknown) =>
  requestRoute(
    new Request("http://127.0.0.1/api/privileged/request", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const progress = (id?: string) =>
  progressRoute(
    new Request(`http://127.0.0.1/api/privileged/progress${id ? `?id=${id}` : ""}`),
  );

async function trayRunning(): Promise<void> {
  await writeFile(livenessPath(), `${Date.now()}\n`, "utf8");
}

describe("POST /api/privileged/request", () => {
  test("refuses with 409 when the menu-bar app is not running, and queues nothing", async () => {
    const response = await post({ kind: "apply" });
    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body.trayAlive).toBe(false);
    expect(body.request).toBeNull();
    expect(body.error).toContain("menu-bar app is not running");

    // Nothing must be left behind for a tray that starts later to replay.
    expect(await Bun.file(applyRequestPath()).exists()).toBe(false);
  });

  test("writes the request when the tray is alive", async () => {
    await trayRunning();
    const response = await post({ kind: "apply" });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.trayAlive).toBe(true);
    expect(body.request.kind).toBe("apply");
    expect(JSON.parse(await Bun.file(applyRequestPath()).text()).id).toBe(body.request.id);
  });

  test("an unknown kind is a 400, not a queued request", async () => {
    await trayRunning();
    const response = await post({ kind: "reboot" });
    expect(response.status).toBe(400);
    expect(await Bun.file(applyRequestPath()).exists()).toBe(false);
  });
});

describe("GET /api/privileged/progress", () => {
  test("is idle and never cached on a machine that was never asked", async () => {
    const response = await progress();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      state: "idle",
      trayAlive: false,
      request: null,
      result: null,
    });
  });

  test("follows one id from pending to done", async () => {
    await trayRunning();
    const { request } = await (await post({ kind: "apply" })).json();

    expect((await (await progress(request.id)).json()).state).toBe("pending");

    const now = new Date().toISOString();
    await writeFile(
      applyResultPath(),
      JSON.stringify({
        id: request.id,
        kind: "apply",
        ok: true,
        cancelled: false,
        error: null,
        startedAt: now,
        finishedAt: now,
      }),
      "utf8",
    );

    const done = await (await progress(request.id)).json();
    expect(done.state).toBe("done");
    expect(done.result.ok).toBe(true);
  });

  test("a corrupt request file answers 200/idle rather than failing the poll", async () => {
    await writeFile(applyRequestPath(), "{{{", "utf8");
    const response = await progress();
    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("idle");
  });
});
