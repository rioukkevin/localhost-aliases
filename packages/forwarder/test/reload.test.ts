/**
 * Reload behaviour. The port-only case is the one that matters: it is what lets the app
 * change a target port without an admin prompt, so it must not disturb any listener.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ForwarderStatus } from "@localhost-aliases/core/types";
import { Forwarder } from "../src/forwarder.ts";
import { cleanup, freePort, httpGet, isRefused, route, tempDir, waitFor, writeRoutes } from "./helpers.ts";

let dir: string;
let routesFile: string;
let statusFile: string;
let forwarder: Forwarder;
let one: ReturnType<typeof Bun.serve>;
let two: ReturnType<typeof Bun.serve>;
let portA: number;
let portB: number;

const serve = (body: string): ReturnType<typeof Bun.serve> =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });

async function status(): Promise<ForwarderStatus> {
  return JSON.parse(await Bun.file(statusFile).text()) as ForwarderStatus;
}

const get = httpGet;

beforeEach(async () => {
  dir = await tempDir();
  routesFile = join(dir, "routes.json");
  statusFile = join(dir, "forwarder-status.json");
  one = serve("upstream one");
  two = serve("upstream two");
  portA = freePort();
  portB = freePort();
  await writeRoutes(routesFile, [route(portA, one.port!, "a.test"), route(portB, one.port!, "b.test")]);
  forwarder = new Forwarder({ routesFile, statusFile, pollMs: 100, log: () => {} });
  await forwarder.start();
});

afterEach(async () => {
  await forwarder.stop();
  one.stop(true);
  two.stop(true);
  await cleanup(dir);
});

test("a port-only change retargets without touching the listeners", async () => {
  expect(await get(portA)).toBe("upstream one");
  expect(await get(portB)).toBe("upstream one");

  // A connection open across the reload, on the route that is *not* changing.
  const chunks: Uint8Array[] = [];
  const kept = await Bun.connect({
    hostname: "127.0.0.1",
    port: portB,
    socket: {
      data(_s, d) {
        chunks.push(new Uint8Array(d));
      },
    },
  });

  await writeRoutes(routesFile, [route(portA, two.port!, "a.test"), route(portB, one.port!, "b.test")]);
  await waitFor(async () => (await status()).routes.some((r) => r.targetPort === two.port), {
    what: "the reload to land",
  });

  expect(await get(portA)).toBe("upstream two"); // retargeted
  expect(await get(portB)).toBe("upstream one"); // untouched

  // The connection opened before the reload is still usable.
  kept.write(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: b\r\nConnection: close\r\n\r\n"));
  await waitFor(() => Buffer.concat(chunks).includes("upstream one"), { what: "the kept connection to answer" });
  kept.end();
});

test("a removed route stops listening and leaves the others alone", async () => {
  await writeRoutes(routesFile, [route(portA, one.port!, "a.test")]);
  await waitFor(async () => (await status()).routes.length === 1, { what: "the route to be dropped" });

  expect(await get(portA)).toBe("upstream one");
  expect(await isRefused(portB)).toBe(true);
});

test("a new route is picked up without a restart", async () => {
  const portC = freePort();
  await writeRoutes(routesFile, [
    route(portA, one.port!, "a.test"),
    route(portB, one.port!, "b.test"),
    route(portC, two.port!, "c.test"),
  ]);
  await waitFor(async () => (await status()).routes.length === 3, { what: "the new route to bind" });
  expect(await get(portC)).toBe("upstream two");
  expect(await get(portA)).toBe("upstream one");
});

test("a route that cannot bind is reported, and the others keep working", async () => {
  const taken = freePort();
  const squatter = Bun.listen({ hostname: "127.0.0.1", port: taken, socket: { data() {} } });

  await writeRoutes(routesFile, [
    route(portA, one.port!, "a.test"),
    route(portB, one.port!, "b.test"),
    route(taken, one.port!, "taken.test"),
  ]);
  await waitFor(async () => (await status()).failures.length === 1, { what: "the bind failure to be reported" });

  const live = await status();
  expect(live.failures[0]?.route.hostname).toBe("taken.test");
  expect(live.failures[0]?.error).toContain("EADDRINUSE");
  expect(live.routes.map((r) => r.hostname).sort()).toEqual(["a.test", "b.test"]);
  expect(await get(portA)).toBe("upstream one"); // one bad route took nothing down

  // Nobody edits routes.json when a squatter goes away, so the bind is retried on the poll.
  squatter.stop(true);
  await waitFor(async () => (await status()).failures.length === 0, { what: "the bind to be retried" });
  expect((await status()).routes.map((r) => r.hostname).sort()).toEqual(["a.test", "b.test", "taken.test"]);
  expect(await get(taken)).toBe("upstream one");
});

test("an unusable routes file keeps the current routes and says so", async () => {
  await Bun.write(routesFile, "{ this is not json");
  await waitFor(async () => (await status()).failures.length > 0, { what: "the parse error to be reported" });

  const live = await status();
  expect(live.routes).toHaveLength(2); // still forwarding
  expect(live.failures[0]?.error).toContain("not valid JSON");
  expect(await get(portA)).toBe("upstream one");

  await writeRoutes(routesFile, [route(portA, two.port!, "a.test"), route(portB, one.port!, "b.test")]);
  await waitFor(async () => (await status()).failures.length === 0, { what: "recovery" });
  expect(await get(portA)).toBe("upstream two");
});

test("the status file reports the pid and is removed on a clean stop", async () => {
  const live = await status();
  expect(live.pid).toBe(process.pid);
  expect(Date.parse(live.startedAt)).toBeGreaterThan(0);

  await forwarder.stop();
  expect(await Bun.file(statusFile).exists()).toBe(false);
});
