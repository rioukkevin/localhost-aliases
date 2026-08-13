import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDesiredState, loadConfig } from "@localhost-aliases/core";
import { NotFoundError } from "../lib/http.ts";
import { ValidationError } from "../lib/service.ts";
import { advanceOnboarding, getOnboarding } from "../lib/onboarding.ts";
import { createAliasAndSync, updateSettingsAndSync } from "../lib/service.ts";
import { appliedProbes, sandbox, stubProbes, type Sandbox } from "./helpers.ts";

let box: Sandbox;
const bare = { probes: stubProbes(), probeStatuses: false as const };

beforeEach(async () => {
  box = await sandbox();
});
afterEach(() => box.cleanup());

describe("getOnboarding", () => {
  test("returns the five contract steps in order, all pending on a fresh machine", async () => {
    const state = await getOnboarding(bare);

    expect(state.steps.map((s) => s.id)).toEqual(["explain", "apply", "verify", "https", "mcp"]);
    expect(state.steps.every((s) => s.state === "pending")).toBe(true);
    expect(state.complete).toBe(false);
    expect(state.skipped).toBe(false);
  });

  test("the explain step lists exactly what the privileged batch will change", async () => {
    await createAliasAndSync({ name: "shop", port: 3000 }, bare);
    const state = await getOnboarding(bare);

    expect(state.changes.join(" ")).toContain("127.0.0.3 shop.local");
    expect(state.changes.join(" ")).toContain("Add 2 loopback addresses to lo0");
    expect(state.changes.join(" ")).toContain("Nothing is installed permanently");
    expect(state.command).toContain("apply.sh");
    expect(state.verifyUrl).toBe("http://index.local");
  });

  test("the apply step only reports done when the machine really matches", async () => {
    const pending = await getOnboarding(bare);
    expect(pending.steps[1]!.state).toBe("pending");
    expect(pending.steps[1]!.needsUser).toBe(true);

    const applied = appliedProbes(buildDesiredState(await loadConfig()));
    const after = await getOnboarding({ probes: applied, probeStatuses: false });
    expect(after.steps[1]!.state).toBe("done");
    expect(after.steps[1]!.needsUser).toBe(false);
  });

  test("mcp clients are reported with their config paths", async () => {
    const state = await getOnboarding(bare);
    expect(state.mcpClients.map((c) => c.id)).toEqual(["claude", "codex"]);
    expect(state.mcpClients[1]!.snippet).toContain("[mcp_servers.localhost-aliases]");
    expect(state.mcpClients.every((c) => c.configured === false)).toBe(true);
  });
});

describe("advanceOnboarding", () => {
  test("explain is remembered across calls", async () => {
    const after = await advanceOnboarding("explain", {}, bare);
    expect(after.steps[0]!.state).toBe("done");

    const record = JSON.parse(await readFile(join(box.configDir, "onboarding.json"), "utf8"));
    expect(record.steps.explain.state).toBe("done");
    expect((await getOnboarding(bare)).steps[0]!.state).toBe("done");
  });

  test("apply returns the intent and never runs it", async () => {
    const after = await advanceOnboarding("apply", {}, bare);
    expect(after.intent?.required).toBe(true);
    expect(after.intent?.command[0]).toContain("apply.sh");
    // Still pending: only the tray's privileged batch can change that.
    expect(after.steps[1]!.state).toBe("pending");
  });

  test("verify records the real fetch result, failure included", async () => {
    // A TLD nothing can resolve, so the request fails fast and deterministically.
    await updateSettingsAndSync({ tld: "invalid" }, bare);
    const after = await advanceOnboarding("verify", {}, bare);

    const record = JSON.parse(await readFile(join(box.configDir, "onboarding.json"), "utf8"));
    expect(record.steps.verify.state).toBe("failed");
    expect(record.steps.verify.hostname).toBe("index.invalid");
    // Unapplied machines never show a stale verify result.
    expect(after.steps[2]!.state).toBe("pending");
  });

  test("https must be skipped explicitly; the dashboard cannot mint a trusted CA", async () => {
    await expect(advanceOnboarding("https", {}, bare)).rejects.toBeInstanceOf(ValidationError);

    const after = await advanceOnboarding("https", { skip: true }, bare);
    expect(after.steps[3]!.state).toBe("skipped");
    expect(after.steps[3]!.detail).toContain("never decrypted");
  });

  test("mcp installs the requested client, or skips", async () => {
    const skipped = await advanceOnboarding("mcp", { skip: true }, bare);
    expect(skipped.steps[4]!.state).toBe("skipped");

    const installed = await advanceOnboarding("mcp", { client: "codex" }, bare);
    expect(installed.steps[4]!.state).toBe("done");
    expect(installed.mcpClients.find((c) => c.id === "codex")?.configured).toBe(true);
  });

  test("skip and restart move the whole flow", async () => {
    await advanceOnboarding("explain", {}, bare);
    const skipped = await advanceOnboarding("skip", {}, bare);
    expect(skipped.skipped).toBe(true);
    expect(skipped.steps[0]!.state).toBe("done");

    const restarted = await advanceOnboarding("restart", {}, bare);
    expect(restarted.skipped).toBe(false);
    expect(restarted.steps[0]!.state).toBe("pending");
  });

  test("an unknown step is a 404", async () => {
    await expect(advanceOnboarding("teleport", {}, bare)).rejects.toBeInstanceOf(NotFoundError);
    await expect(advanceOnboarding(undefined, {}, bare)).rejects.toBeInstanceOf(NotFoundError);
  });
});
