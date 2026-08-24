/**
 * The offline page over a real socket, through a real Forwarder.
 *
 * Unprivileged throughout: 127.0.0.1, ports above 1024, no lo0 alias, no /etc/hosts. The
 * three cases that matter are the three the contract names — a live upstream is untouched,
 * a dead upstream answers an HTTP client, and a dead upstream says NOTHING to a client that
 * is not speaking HTTP.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Route } from "@localhost-aliases/core/types";
import { Forwarder } from "../src/forwarder.ts";
import { cleanup, freePort, tempDir, waitFor } from "./helpers.ts";

let dir: string;
let forwarder: Forwarder;
let listenPort: number;

beforeEach(async () => {
  dir = await tempDir();
  listenPort = freePort();
});

afterEach(async () => {
  await forwarder?.stop();
  await cleanup(dir);
});

async function bind(route: Route): Promise<void> {
  forwarder = new Forwarder({
    statusFile: join(dir, "forwarder-status.json"),
    watchRoutesFile: false,
    log: () => {},
  });
  await forwarder.start();
  await forwarder.setRoutes([route]);
}

/** Everything the server sent back before it closed, as raw bytes. */
async function speak(port: number, opener: string | Uint8Array): Promise<string> {
  const chunks: Uint8Array[] = [];
  let done = false;
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_s, d) => void chunks.push(new Uint8Array(d)),
      close: () => void (done = true),
      end: () => void (done = true),
    },
  });
  socket.write(opener);
  await waitFor(() => done, { timeoutMs: 4_000, what: `${port} to close` });
  return Buffer.concat(chunks).toString("utf8");
}

const deadPort = (): number => freePort(); // allocated then released: nothing is listening

test("a live upstream is forwarded byte for byte — the offline path costs the working path nothing", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("the real app") });
  await bind({ ip: "127.0.0.1", listenPort, targetPort: upstream.port!, hostname: "myapp.test" });

  const reply = await speak(listenPort, "GET / HTTP/1.1\r\nHost: myapp.test\r\nConnection: close\r\n\r\n");
  expect(reply).toContain("the real app");
  expect(reply).not.toContain("503");
  upstream.stop(true);
});

test("a dead upstream renders the 503, naming the alias, the port and the hint's command", async () => {
  await bind({
    ip: "127.0.0.1",
    listenPort,
    targetPort: deadPort(),
    hostname: "myapp.test",
    hint: { framework: "Next.js", command: "next dev -p 3000" },
  });

  const reply = await speak(listenPort, "GET / HTTP/1.1\r\nHost: myapp.test\r\nConnection: close\r\n\r\n");
  expect(reply.startsWith("HTTP/1.1 503 Service Unavailable")).toBe(true);
  expect(reply).toContain("Content-Type: text/html");
  expect(reply).toContain("myapp");
  expect(reply).toContain("next dev -p 3000");
  expect(reply).toContain("Next.js");
});

test("a dead upstream with no hint still explains itself, without inventing a command", async () => {
  const target = deadPort();
  await bind({ ip: "127.0.0.1", listenPort, targetPort: target, hostname: "shop.test" });

  const reply = await speak(listenPort, "GET /admin HTTP/1.1\r\nHost: shop.test\r\n\r\n");
  expect(reply).toContain("503");
  expect(reply).toContain(String(target));
  expect(reply).toContain("no command known");
});

test("a raw non-HTTP connection is CLOSED WITHOUT A RESPONSE", async () => {
  await bind({ ip: "127.0.0.1", listenPort, targetPort: deadPort(), hostname: "db.test" });

  // A TLS ClientHello and a Postgres startup packet. Writing HTML into either of these is
  // how you turn "the server is down" into "the client library is broken".
  for (const opener of [
    new Uint8Array([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc]),
    new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]),
  ]) {
    expect(await speak(listenPort, opener)).toBe("");
  }
});

test("a client that connects and says nothing is closed in silence too", async () => {
  await bind({ ip: "127.0.0.1", listenPort, targetPort: deadPort(), hostname: "quiet.test" });
  expect(await speak(listenPort, new Uint8Array())).toBe("");
});

test("the page arrives even when the request is split across packets", async () => {
  await bind({ ip: "127.0.0.1", listenPort, targetPort: deadPort(), hostname: "slow.test" });

  const chunks: Uint8Array[] = [];
  let done = false;
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: listenPort,
    socket: {
      data: (_s, d) => void chunks.push(new Uint8Array(d)),
      close: () => void (done = true),
      end: () => void (done = true),
    },
  });
  // "GE" alone is not a verdict — it is still consistent with GET, so the agent waits.
  socket.write("GE");
  await Bun.sleep(30);
  expect(Buffer.concat(chunks).toString("utf8")).toBe("");
  socket.write("T / HTTP/1.1\r\n\r\n");

  await waitFor(() => done, { timeoutMs: 4_000, what: "the split request to be answered" });
  expect(Buffer.concat(chunks).toString("utf8")).toContain("503");
});
