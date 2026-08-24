/**
 * Launch at login, both halves of the contract.
 *
 * The one rule under test everywhere below: an answer we do not have is `"unknown"`, and
 * `"unknown"` is not "off". The Swift side is written by someone else and may not have
 * shipped its half yet; a dashboard that renders "launch at login is off" because a file
 * was missing would be stating something about the user's Mac that it never checked.
 *
 * The wire shapes here are apps/tray/Sources/LoginItem.swift's, verbatim — the request the
 * tray decodes (`action`, not a boolean) and the status it publishes (with `lastRequestId`,
 * which is how a pending ask is settled).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  loginItemPath,
  loginItemRequestPath,
  readLaunchAtLogin,
  requestLaunchAtLogin,
} from "../lib/launch-at-login.ts";
import { APPLY_REQUEST_TTL_MS } from "@localhost-aliases/core";
import { toLaunchAtLogin } from "../lib/client/api.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let box: Sandbox;

beforeEach(async () => {
  box = await sandbox();
  await mkdir(box.configDir, { recursive: true });
});
afterEach(() => box.cleanup());

async function trayWrote(body: unknown): Promise<void> {
  await writeFile(loginItemPath(), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

describe("reading what the menu-bar app reported", () => {
  test("no file at all is unknown — never off, and never a boolean", async () => {
    const state = await readLaunchAtLogin();
    expect(state.status).toBe("unknown");
    expect(state.enabled).toBeNull();
    expect(state.canToggle).toBeNull();
    expect(state.updatedAt).toBeNull();
    expect(state.pending).toBe(false);
  });

  test("every status the tray can publish survives the trip verbatim", async () => {
    for (const status of ["enabled", "requiresApproval", "notRegistered", "notFound"]) {
      await trayWrote({ status, enabled: status === "enabled", updatedAt: "2026-01-01T00:00:00.000Z" });
      expect((await readLaunchAtLogin()).status).toBe(status as never);
    }
  });

  /** `.requiresApproval` is registered but NOT launching. Reading it as on is the bug. */
  test("approval outstanding is not on", async () => {
    await trayWrote({
      status: "requiresApproval",
      enabled: false,
      canToggle: true,
      needsSystemSettings: true,
      systemSettingsUrl: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const state = await readLaunchAtLogin();
    expect(state.enabled).toBe(false);
    expect(state.needsSystemSettings).toBe(true);
    expect(state.systemSettingsUrl).toContain("LoginItems-Settings");
  });

  test("notFound carries the tray's own canToggle:false rather than our guess", async () => {
    await trayWrote({ status: "notFound", enabled: false, canToggle: false, updatedAt: "2026-01-01T00:00:00.000Z" });
    expect((await readLaunchAtLogin()).canToggle).toBe(false);
  });

  test("garbage, truncation and a value from a future build all land on unknown", async () => {
    for (const body of ["", "{", "[]", '"enabled"', JSON.stringify({ status: "somethingNew" }), JSON.stringify({})]) {
      await trayWrote(body);
      const state = await readLaunchAtLogin();
      expect(state.status).toBe("unknown");
      expect(state.enabled).toBeNull();
      expect(state.updatedAt).toBeNull();
    }
  });

  test("an unparseable timestamp costs the timestamp, not the status", async () => {
    await trayWrote({ status: "enabled", enabled: true, updatedAt: "not a date" });
    const state = await readLaunchAtLogin();
    expect(state.status).toBe("enabled");
    expect(state.updatedAt).toBeNull();
  });
});

describe("asking for a change", () => {
  test("writes the shape the tray decodes, and claims nothing about the result", async () => {
    await trayWrote({ status: "notRegistered", enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" });
    const state = await requestLaunchAtLogin("enable");

    expect(state.pending).toBe(true);
    expect(state.requested).toBe("enable");
    // Still what the system last said — the ask does not move it.
    expect(state.status).toBe("notRegistered");
    expect(state.enabled).toBe(false);

    const written = JSON.parse(await readFile(loginItemRequestPath(), "utf8")) as Record<string, unknown>;
    expect(written.action).toBe("enable");
    expect(typeof written.id).toBe("string");
    expect(typeof written.requestedAt).toBe("string");
    // The tray decodes `action`, not a boolean. Sending one would be silently ignored.
    expect(written.enabled).toBeUndefined();
  });

  test("stays pending until the published status names that request id", async () => {
    await requestLaunchAtLogin("enable");
    const id = (JSON.parse(await readFile(loginItemRequestPath(), "utf8")) as { id: string }).id;
    expect((await readLaunchAtLogin()).pending).toBe(true);

    await trayWrote({
      status: "enabled",
      enabled: true,
      lastRequestId: id,
      updatedAt: new Date().toISOString(),
    });
    const settled = await readLaunchAtLogin();
    expect(settled.pending).toBe(false);
    expect(settled.status).toBe("enabled");
    expect(settled.requested).toBeNull();
  });

  /** The tray ignores a request older than the TTL, so the UI must stop waiting too. */
  test("an ask the tray would refuse as stale stops reading as pending", async () => {
    await requestLaunchAtLogin("enable");
    expect((await readLaunchAtLogin()).pending).toBe(true);
    expect((await readLaunchAtLogin(Date.now() + APPLY_REQUEST_TTL_MS + 1_000)).pending).toBe(false);
  });

  test("a request the tray never wrote a status for is pending, not silently landed", async () => {
    await requestLaunchAtLogin("disable");
    const state = await readLaunchAtLogin();
    expect(state.status).toBe("unknown");
    expect(state.pending).toBe(true);
    expect(state.requested).toBe("disable");
  });

  test("both files live in the config directory, and nowhere near /Library", () => {
    expect(loginItemPath()).toBe(join(box.configDir, "login-item.json"));
    expect(loginItemRequestPath()).toBe(join(box.configDir, "login-item-request.json"));
  });
});

describe("the client's defensive parse", () => {
  test("a server that never heard of this endpoint reads as unknown", () => {
    for (const body of [null, undefined, "enabled", 42, {}, { status: 1 }, { status: "on" }, []]) {
      const parsed = toLaunchAtLogin(body);
      expect(parsed.status).toBe("unknown");
      expect(parsed.enabled).toBeNull();
    }
  });

  test("a real payload survives whole", () => {
    expect(
      toLaunchAtLogin({
        status: "requiresApproval",
        enabled: false,
        canToggle: true,
        needsSystemSettings: true,
        systemSettingsUrl: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pending: false,
        requested: null,
      }),
    ).toMatchObject({
      status: "requiresApproval",
      enabled: false,
      needsSystemSettings: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("an unknown status keeps the pending ask but drops every measured field", () => {
    const parsed = toLaunchAtLogin({
      status: "???",
      enabled: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      pending: true,
      requested: "enable",
    });
    expect(parsed.enabled).toBeNull();
    expect(parsed.updatedAt).toBeNull();
    expect(parsed.pending).toBe(true);
    expect(parsed.requested).toBe("enable");
  });
});
