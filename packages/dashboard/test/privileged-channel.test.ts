/**
 * The channel is the only thing standing between a click and a password prompt, so it is
 * tested against real files in a temp LA_CONFIG_DIR: fresh request, id matching, stale
 * request, corrupt files, tray alive vs dead. Nothing here runs a privileged command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import {
  APPLY_REQUEST_TTL_MS,
  LIVENESS_TIMEOUT_MS,
  applyRequestPath,
  applyResultPath,
  desiredStatePath,
  livenessPath,
  type PrivilegedRequest,
  type PrivilegedResult,
} from "@localhost-aliases/core";
import { isPrivilegedKind, isTrayAlive, readProgress, requestPrivileged } from "../lib/privileged-channel.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let box: Sandbox;

beforeEach(async () => {
  box = await sandbox();
  await mkdir(box.configDir, { recursive: true });
});
afterEach(() => box.cleanup());

/** The tray's heartbeat, aged by `staleBy` milliseconds. */
async function touchLiveness(staleBy = 0): Promise<void> {
  await writeFile(livenessPath(), `${Date.now()}\n`, "utf8");
  const when = new Date(Date.now() - staleBy);
  await utimes(livenessPath(), when, when);
}

function resultFor(request: PrivilegedRequest, patch: Partial<PrivilegedResult> = {}): PrivilegedResult {
  return {
    id: request.id,
    kind: request.kind,
    ok: true,
    cancelled: false,
    error: null,
    startedAt: request.requestedAt,
    finishedAt: new Date().toISOString(),
    ...patch,
  };
}

async function writeResult(result: PrivilegedResult): Promise<void> {
  await writeFile(applyResultPath(), `${JSON.stringify(result)}\n`, "utf8");
}

describe("requestPrivileged", () => {
  test("writes a request with a fresh uuid, and refreshes the desired state first", async () => {
    const request = await requestPrivileged("apply");

    expect(request.kind).toBe("apply");
    expect(request.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Date.now() - Date.parse(request.requestedAt)).toBeLessThan(5_000);

    // The tray hands the script a path, so the file must already describe current intent.
    const desired = JSON.parse(await readFile(desiredStatePath(), "utf8"));
    expect(Array.isArray(desired.hosts)).toBe(true);

    const onDisk = JSON.parse(await readFile(applyRequestPath(), "utf8"));
    expect(onDisk).toEqual(request);
  });

  test("every call gets its own id, so an old result cannot answer a new request", async () => {
    const first = await requestPrivileged("apply");
    const second = await requestPrivileged("apply");
    expect(second.id).not.toBe(first.id);

    await writeResult(resultFor(first));
    const progress = await readProgress(second.id);
    expect(progress.state).toBe("pending");
    expect(progress.result).toBeNull();
  });

  test("uninstall is a valid kind and is written through unchanged", async () => {
    const request = await requestPrivileged("uninstall");
    expect(request.kind).toBe("uninstall");
    expect(isPrivilegedKind("uninstall")).toBe(true);
    expect(isPrivilegedKind("rm -rf")).toBe(false);
  });
});

describe("readProgress", () => {
  test("a machine that has never been asked is idle, not pending", async () => {
    const progress = await readProgress();
    expect(progress).toEqual({ state: "idle", trayAlive: false, request: null, result: null });
  });

  test("a fresh unanswered request is pending", async () => {
    await touchLiveness();
    const request = await requestPrivileged("apply");

    const progress = await readProgress(request.id);
    expect(progress.state).toBe("pending");
    expect(progress.trayAlive).toBe(true);
    expect(progress.request).toEqual(request);
    expect(progress.result).toBeNull();
  });

  test("a matching result flips the state to done and carries the tray's verdict", async () => {
    const request = await requestPrivileged("apply");
    await writeResult(resultFor(request));

    const progress = await readProgress(request.id);
    expect(progress.state).toBe("done");
    expect(progress.result?.ok).toBe(true);
    expect(progress.result?.cancelled).toBe(false);
  });

  test("a dismissed prompt is done, cancelled, and not an error", async () => {
    const request = await requestPrivileged("apply");
    await writeResult(resultFor(request, { ok: false, cancelled: true, error: null }));

    const progress = await readProgress(request.id);
    expect(progress.state).toBe("done");
    expect(progress.result?.cancelled).toBe(true);
    expect(progress.result?.error).toBeNull();
  });

  test("without an id it describes the last request on disk", async () => {
    const request = await requestPrivileged("apply");
    expect((await readProgress()).state).toBe("pending");

    await writeResult(resultFor(request));
    const progress = await readProgress();
    expect(progress.state).toBe("done");
    expect(progress.request?.id).toBe(request.id);
  });

  test("a result left over from an earlier run never answers a later question", async () => {
    const old = await requestPrivileged("apply");
    await writeResult(resultFor(old));
    // The request file is gone/unknown: asking about some other id must not see this result.
    const progress = await readProgress("00000000-0000-4000-8000-000000000000");
    expect(progress.state).toBe("idle");
    expect(progress.result).toBeNull();
  });

  test("a request older than the TTL with no result fails with an actionable message", async () => {
    const stale: PrivilegedRequest = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "apply",
      requestedAt: new Date(Date.now() - APPLY_REQUEST_TTL_MS - 1_000).toISOString(),
    };
    await writeFile(applyRequestPath(), JSON.stringify(stale), "utf8");

    const progress = await readProgress(stale.id);
    expect(progress.state).toBe("done");
    expect(progress.result?.ok).toBe(false);
    expect(progress.result?.cancelled).toBe(false);
    expect(progress.result?.error).toContain("not running");
    expect(progress.result?.id).toBe(stale.id);
  });

  test("the stale message names the menu instead when the tray is alive but silent", async () => {
    await touchLiveness();
    const stale: PrivilegedRequest = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "apply",
      requestedAt: new Date(Date.now() - APPLY_REQUEST_TTL_MS - 1_000).toISOString(),
    };
    await writeFile(applyRequestPath(), JSON.stringify(stale), "utf8");

    const progress = await readProgress(stale.id);
    expect(progress.trayAlive).toBe(true);
    expect(progress.result?.error).toContain("Apply changes");
  });

  test("corrupt files read as idle rather than throwing", async () => {
    await writeFile(applyRequestPath(), "{ this is not json", "utf8");
    await writeFile(applyResultPath(), "", "utf8");
    expect((await readProgress()).state).toBe("idle");

    // Valid JSON of the wrong shape is just as corrupt.
    await writeFile(applyRequestPath(), JSON.stringify({ id: 7, kind: "nope" }), "utf8");
    await writeFile(applyResultPath(), JSON.stringify([1, 2, 3]), "utf8");
    const progress = await readProgress("11111111-1111-4111-8111-111111111111");
    expect(progress.state).toBe("idle");
    expect(progress.request).toBeNull();
  });

  test("an unparseable requestedAt counts as stale, never as pending forever", async () => {
    await writeFile(
      applyRequestPath(),
      JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", kind: "apply", requestedAt: "whenever" }),
      "utf8",
    );
    const progress = await readProgress();
    expect(progress.state).toBe("done");
    expect(progress.result?.ok).toBe(false);
  });
});

describe("isTrayAlive", () => {
  test("false when the heartbeat file was never written", async () => {
    expect(await isTrayAlive()).toBe(false);
  });

  test("true while the heartbeat is fresh", async () => {
    await touchLiveness();
    expect(await isTrayAlive()).toBe(true);
  });

  test("false once the heartbeat is older than the timeout", async () => {
    await touchLiveness(LIVENESS_TIMEOUT_MS + 1_000);
    expect(await isTrayAlive()).toBe(false);
  });

  test("progress reports the dead tray alongside a pending request", async () => {
    const request = await requestPrivileged("apply");
    await touchLiveness(LIVENESS_TIMEOUT_MS + 1_000);

    const progress = await readProgress(request.id);
    expect(progress.state).toBe("pending");
    expect(progress.trayAlive).toBe(false);
  });
});
