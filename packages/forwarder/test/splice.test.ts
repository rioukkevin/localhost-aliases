/**
 * Passthrough proofs. Everything runs on 127.0.0.1 with listen ports above 1024 — the
 * forwarder takes the port from the route, so nothing here needs privileges.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Forwarder } from "../src/forwarder.ts";
import { bufferedBytes } from "../src/splice.ts";
import { cleanup, freePort, payload, rawEcho, route, sha256, tempDir, waitFor, writeRoutes } from "./helpers.ts";

let dir: string;
let upstream: ReturnType<typeof Bun.serve>;
let forwarder: Forwarder;
let listenPort: number;

beforeAll(async () => {
  dir = await tempDir();
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: undefined })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/echo") {
        const body = new Uint8Array(await req.arrayBuffer());
        return new Response(body, { headers: { "x-sha": sha256(body), "x-method": req.method } });
      }
      return new Response(`hello ${url.pathname}`, { headers: { "x-header": req.headers.get("x-probe") ?? "" } });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
    },
  });

  listenPort = freePort();
  const routesFile = join(dir, "routes.json");
  await writeRoutes(routesFile, [route(listenPort, upstream.port!, "splice.local")]);
  forwarder = new Forwarder({
    routesFile,
    statusFile: join(dir, "forwarder-status.json"),
    log: () => {},
  });
  await forwarder.start();
});

afterAll(async () => {
  await forwarder.stop();
  upstream.stop(true);
  await cleanup(dir);
});

const base = (): string => `http://127.0.0.1:${listenPort}`;

test("an HTTP request round-trips untouched", async () => {
  const res = await fetch(`${base()}/hi`, { headers: { "x-probe": "kept" } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello /hi");
  expect(res.headers.get("x-header")).toBe("kept");
});

test("a 6MB body transfers intact in both directions", async () => {
  const body = payload(6 * 1024 * 1024);
  const expected = sha256(body);
  const res = await fetch(`${base()}/echo`, { method: "POST", body: new Blob([body]) });
  expect(res.headers.get("x-sha")).toBe(expected); // upstream received every byte
  const back = new Uint8Array(await res.arrayBuffer());
  expect(back.byteLength).toBe(body.byteLength);
  expect(sha256(back)).toBe(expected); // and every byte came back
});

test("a WebSocket echoes through the forwarder", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${listenPort}/ws`);
  const messages: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => {
      messages.push(String(e.data));
      if (messages.length === 2) resolve();
      else ws.send("pong");
    };
    ws.onerror = () => reject(new Error("websocket error"));
    setTimeout(() => reject(new Error("websocket timed out")), 3_000);
  });
  ws.close();
  expect(messages).toEqual(["ping", "pong"]);
});

test("raw TCP bytes pass through untouched, and an abandoned pair is reaped", async () => {
  const echo = rawEcho();
  const port = freePort();
  const routesFile = join(dir, "raw-routes.json");
  await writeRoutes(routesFile, [route(port, echo.port, "raw.local")]);
  // Bun cannot tell a half-closed client from one that vanished, so a finished pair is
  // reaped on a timer. One second here; the shipped default is 15.
  const raw = new Forwarder({
    routesFile,
    statusFile: join(dir, "raw-status.json"),
    lingerSeconds: 1,
    log: () => {},
  });
  await raw.start();

  const chunks: Uint8Array[] = [];
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        chunks.push(new Uint8Array(d));
      },
    },
  });
  // Bytes an HTTP proxy would choke on: NUL, high bytes, no framing at all.
  client.write(new Uint8Array([0, 1, 2, 253, 254, 255]));
  await waitFor(() => Buffer.concat(chunks).length === 6, { what: "the echo to come back" });
  expect([...Buffer.concat(chunks)]).toEqual([0, 1, 2, 253, 254, 255]);

  client.end();
  await waitFor(() => echo.closes === 1, { timeoutMs: 6_000, what: "the upstream connection to be reaped" });

  await raw.stop();
  echo.stop();
}, 15_000);

test("a slow reader does not balloon memory: queued bytes stay bounded", async () => {
  const size = 16 * 1024 * 1024;
  const data = payload(size);
  // Upstream blasts the whole payload as fast as the socket will take it.
  const blaster = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        let offset = 0;
        const step = (): void => {
          while (offset < size) {
            const n = socket.write(data.subarray(offset));
            if (n <= 0) break;
            offset += n;
          }
          if (offset >= size) return void socket.end();
          setTimeout(step, 5);
        };
        step();
      },
      data() {},
    },
  });

  const port = freePort();
  const routesFile = join(dir, "bp-routes.json");
  await writeRoutes(routesFile, [route(port, blaster.port, "bp.local")]);
  const bp = new Forwarder({ routesFile, statusFile: join(dir, "bp-status.json"), log: () => {} });
  await bp.start();

  let received = 0;
  let done = false;
  const hasher = new Bun.CryptoHasher("sha256");
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(socket) {
        socket.pause(); // a client that stops reading, mid-download
      },
      data(_s, d) {
        received += d.byteLength;
        hasher.update(d);
      },
      close() {
        done = true;
      },
      end() {
        done = true;
      },
    },
  });

  const before = bufferedBytes();
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(10);
    peak = Math.max(peak, bufferedBytes() - before);
  }
  // At most one partially-written read chunk, never a slice of the stream: the same peak
  // shows up whether 8MB or 64MB is pushed through.
  expect(peak).toBeLessThan(size / 4);

  client.resume();
  await waitFor(() => done && received >= size, { timeoutMs: 30_000, what: "the whole stream to arrive" });
  expect(received).toBe(size);
  expect(hasher.digest("hex")).toBe(sha256(data));
  expect(bufferedBytes()).toBe(before); // nothing leaked once the connection ended

  client.end();
  await bp.stop();
  blaster.stop(true);
}, 60_000);
