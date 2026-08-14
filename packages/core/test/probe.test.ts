import { afterAll, describe, expect, test } from "bun:test";
import { probeAll, probePort, toView } from "../src/probe.ts";
import type { Alias, Config } from "../src/types.ts";

// Bound on 127.0.0.1 with an ephemeral (high) port: never privileged, never 80.
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
const OPEN_PORT: number = server.port!;

// A port nothing listens on: taken from a second server that is then stopped.
const scratch = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no") });
const CLOSED_PORT: number = scratch.port!;
scratch.stop(true);

afterAll(() => server.stop(true));

describe("probePort", () => {
  test("a listening port is up", async () => {
    expect(await probePort("127.0.0.1", OPEN_PORT)).toBe("up");
  });

  test("a closed port is down", async () => {
    expect(await probePort("127.0.0.1", CLOSED_PORT)).toBe("down");
  });

  test("an unresolvable host is down", async () => {
    expect(await probePort("nothing.invalid", 4444, 200)).toBe("down");
  });

  test("an invalid port is unknown, without opening a socket", async () => {
    expect(await probePort("127.0.0.1", 0)).toBe("unknown");
    expect(await probePort("127.0.0.1", 70000)).toBe("unknown");
    expect(await probePort("127.0.0.1", 1.5)).toBe("unknown");
  });

  test("an empty host is unknown", async () => {
    expect(await probePort("", 3000)).toBe("unknown");
  });

  test("a zero timeout still resolves rather than hanging", async () => {
    expect(["up", "down"]).toContain(await probePort("127.0.0.1", OPEN_PORT, 0));
  });

  test("probing does not disturb the server", async () => {
    await probePort("127.0.0.1", OPEN_PORT);
    const res = await fetch(`http://127.0.0.1:${OPEN_PORT}/`);
    expect(await res.text()).toBe("ok");
  });
});

describe("probeAll", () => {
  test("keys results by id and defaults to 127.0.0.1", async () => {
    const result = await probeAll([
      { id: "open", port: OPEN_PORT },
      { id: "closed", port: CLOSED_PORT },
      { id: "bad", port: 0 },
    ]);
    expect(result).toEqual({ open: "up", closed: "down", bad: "unknown" });
  });

  test("probes more targets than the concurrency limit", async () => {
    const targets = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, port: OPEN_PORT }));
    const result = await probeAll(targets);
    expect(Object.keys(result)).toHaveLength(25);
    expect(Object.values(result).every((s) => s === "up")).toBe(true);
  });

  test("an explicit host is honoured", async () => {
    expect(await probeAll([{ id: "a", host: "127.0.0.1", port: OPEN_PORT }])).toEqual({ a: "up" });
  });

  test("no targets is not an error", async () => {
    expect(await probeAll([])).toEqual({});
  });

  test("concurrency of 1 still completes", async () => {
    const result = await probeAll(
      [
        { id: "a", port: OPEN_PORT },
        { id: "b", port: OPEN_PORT },
      ],
      { concurrency: 1 },
    );
    expect(result).toEqual({ a: "up", b: "up" });
  });
});

describe("toView", () => {
  const config: Config = { version: 2, tld: "local", dashboardPort: 7788, https: true, autoApply: true, aliases: [] };
  const alias: Alias = {
    id: "a",
    name: "myapp",
    port: 3000,
    ip: "127.0.0.3",
    projectPath: null,
    description: null,
    enabled: true,
    reserved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("adds hostname, url and status", () => {
    expect(toView(alias, config, "up")).toMatchObject({
      hostname: "myapp.local",
      url: "http://myapp.local",
      status: "up",
    });
  });

  test("status defaults to unknown", () => {
    expect(toView(alias, config).status).toBe("unknown");
  });

  test("stays http even when https is enabled: raw TCP cannot terminate TLS", () => {
    expect(toView(alias, config).url.startsWith("http://")).toBe(true);
  });

  test("uses the configured TLD", () => {
    expect(toView(alias, { ...config, tld: "test" }).hostname).toBe("myapp.test");
  });
});
