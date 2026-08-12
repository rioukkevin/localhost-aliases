import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Alias, type Config } from "../src/types.ts";
import { probeAll, probePort, toView } from "../src/probe.ts";

const REAL_CONNECT = Bun.connect;

/** Bun.connect is a writable property, so tests can substitute a fake dialer. */
function stubConnect(fn: (opts: { hostname: string; port: number }) => Promise<unknown>): void {
  (Bun as unknown as { connect: unknown }).connect = fn;
}

afterEach(() => {
  (Bun as unknown as { connect: unknown }).connect = REAL_CONNECT;
});

function alias(partial: Partial<Alias>): Alias {
  return {
    id: crypto.randomUUID(),
    name: "myapp",
    port: 3000,
    target: "127.0.0.1",
    projectPath: null,
    description: null,
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

/** Opens a listener, notes its port, then closes it: a port nothing can answer. */
async function closedPort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

function listen(): { port: number; stop: () => void } {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  return { port: server.port, stop: () => server.stop(true) };
}

describe("probePort", () => {
  test("reports up when something is listening", async () => {
    const server = listen();
    try {
      expect(await probePort("127.0.0.1", server.port)).toBe("up");
    } finally {
      server.stop();
    }
  });

  test("reports down when the connection is refused", async () => {
    expect(await probePort("127.0.0.1", await closedPort())).toBe("down");
  });

  test("reports down when the connect attempt outlives the timeout", async () => {
    stubConnect(() => new Promise(() => {}));
    const started = Date.now();
    expect(await probePort("127.0.0.1", 3000, 20)).toBe("down");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("reports down for known network error codes", async () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]) {
      stubConnect(() => Promise.reject(Object.assign(new Error("nope"), { code })));
      expect(await probePort("127.0.0.1", 3000, 50)).toBe("down");
    }
  });

  test("reports unknown for an unexpected failure", async () => {
    stubConnect(() => Promise.reject(new Error("something else entirely")));
    expect(await probePort("127.0.0.1", 3000, 50)).toBe("unknown");
  });

  test("reports unknown when connect throws synchronously", async () => {
    stubConnect(() => {
      throw new Error("bad options");
    });
    expect(await probePort("127.0.0.1", 3000, 50)).toBe("unknown");
  });

  test.each([0, -1, 65536, 3000.5, Number.NaN])("reports unknown for port %p", async (port) => {
    expect(await probePort("127.0.0.1", port)).toBe("unknown");
  });

  test("defaults to a 300ms timeout", async () => {
    stubConnect(() => new Promise(() => {}));
    const started = Date.now();
    expect(await probePort("127.0.0.1", 3000)).toBe("down");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("probeAll", () => {
  test("returns an entry per alias, keyed by id", async () => {
    const server = listen();
    try {
      const up = alias({ name: "up", port: server.port });
      const down = alias({ name: "down", port: await closedPort() });
      const statuses = await probeAll([up, down]);
      expect(statuses.size).toBe(2);
      expect(statuses.get(up.id)).toBe("up");
      expect(statuses.get(down.id)).toBe("down");
    } finally {
      server.stop();
    }
  });

  test("handles an empty list", async () => {
    expect((await probeAll([])).size).toBe(0);
  });

  test("never runs more than 8 probes at once", async () => {
    let inFlight = 0;
    let peak = 0;
    stubConnect(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
      return { end() {} };
    });

    const aliases = Array.from({ length: 30 }, (_, i) => alias({ name: `app-${i}`, port: 3000 + i }));
    const statuses = await probeAll(aliases, 5000);
    expect(statuses.size).toBe(30);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  test("probes each alias on its own target and port", async () => {
    const seen: string[] = [];
    stubConnect(async ({ hostname, port }) => {
      seen.push(`${hostname}:${port}`);
      return { end() {} };
    });
    await probeAll([
      alias({ name: "a", port: 3001, target: "127.0.0.1" }),
      alias({ name: "b", port: 3002, target: "::1" }),
    ]);
    expect(seen.sort()).toEqual(["127.0.0.1:3001", "::1:3002"]);
  });
});

describe("toView", () => {
  const config: Config = { ...DEFAULT_CONFIG, aliases: [] };
  /** Phase 4 flipped DEFAULT_CONFIG.https on; the http leg still has to be exercised. */
  const plain: Config = { ...config, https: false };

  test("adds hostname, url and status", () => {
    const view = toView(alias({ name: "myapp", port: 3000 }), config, "up");
    expect(view.hostname).toBe("myapp.local");
    expect(view.url).toBe("https://myapp.local");
    expect(view.status).toBe("up");
    expect(view.port).toBe(3000);
  });

  test("the default config is https", () => {
    expect(DEFAULT_CONFIG.https).toBe(true);
    expect(toView(alias({ name: "myapp" }), config, "up").url.startsWith("https://")).toBe(true);
  });

  test("uses the https listener port when https is on", () => {
    expect(toView(alias({ name: "myapp" }), config, "down").url).toBe("https://myapp.local");
    expect(toView(alias({ name: "myapp" }), { ...config, httpsPort: 8443 }, "down").url).toBe(
      "https://myapp.local:8443",
    );
  });

  test("falls back to the http listener port when https is off", () => {
    expect(toView(alias({ name: "myapp" }), plain, "down").url).toBe("http://myapp.local");
  });

  test("shows a non-default http port", () => {
    expect(toView(alias({ name: "myapp" }), { ...plain, httpPort: 8080 }, "unknown").url).toBe(
      "http://myapp.local:8080",
    );
  });

  test("follows the configured tld", () => {
    expect(toView(alias({ name: "myapp" }), { ...config, tld: "test" }, "up").hostname).toBe(
      "myapp.test",
    );
  });

  test("keeps every alias field", () => {
    const source = alias({ name: "myapp", description: "hi", projectPath: "/tmp/p" });
    const view = toView(source, config, "down");
    expect(view).toMatchObject(source);
  });
});
