/**
 * The one case Bun's own sockets cannot express: a client that closes its write half and
 * then waits for the reply. Bun's `end()`/`shutdown()` stop that socket from reading, so the
 * client here is python — the same thing a real `curl`, `nc -N` or database client does.
 *
 * Skipped, not faked, where python3 is unavailable.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Forwarder } from "../src/forwarder.ts";
import { cleanup, freePort, rawEcho, route, tempDir, writeRoutes } from "./helpers.ts";

const python = Bun.which("python3");

const CLIENT = `
import socket, sys
port = int(sys.argv[1])
s = socket.create_connection(("127.0.0.1", port), timeout=8)
s.sendall(b"GET /hi HTTP/1.1\\r\\nHost: probe\\r\\nConnection: close\\r\\n\\r\\n")
s.shutdown(socket.SHUT_WR)   # half-close: no more request bytes, still expecting a reply
out = b""
try:
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        out += chunk
except socket.timeout:
    out += b"<TIMEOUT>"
sys.stdout.write(repr(out))
`;

let dir = "";
let forwarder: Forwarder | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  await forwarder?.stop();
  forwarder = null;
  upstream?.stop(true);
  upstream = null;
  if (dir) await cleanup(dir);
});

async function halfCloseClient(port: number): Promise<string> {
  const script = join(dir, "half-close-client.py");
  await Bun.write(script, CLIENT);
  const proc = Bun.spawn([python!, script, String(port)], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

test.skipIf(!python)("a client that half-closes still gets its response", async () => {
  dir = await tempDir();
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("half-close ok") });
  const listenPort = freePort();
  await writeRoutes(join(dir, "routes.json"), [route(listenPort, upstream.port!, "half.local")]);
  forwarder = new Forwarder({
    routesFile: join(dir, "routes.json"),
    statusFile: join(dir, "status.json"),
    log: () => {},
  });
  await forwarder.start();

  const direct = await halfCloseClient(upstream.port!);
  const proxied = await halfCloseClient(listenPort);

  expect(proxied).toContain("half-close ok");
  expect(proxied).not.toContain("TIMEOUT");
  // Byte for byte the same exchange, minus the Date header the server stamps per request.
  const strip = (s: string): string => s.replace(/Date: [^\\]+\\r\\n/, "");
  expect(strip(proxied)).toBe(strip(direct));
}, 20_000);

test.skipIf(!python)("a half-closed connection nothing answers is reaped", async () => {
  dir = await tempDir();
  const silent = rawEcho(); // accepts the connection, replies to nothing it is not sent
  const listenPort = freePort();
  await writeRoutes(join(dir, "routes.json"), [route(listenPort, silent.port, "silent.local")]);
  forwarder = new Forwarder({
    routesFile: join(dir, "routes.json"),
    statusFile: join(dir, "status.json"),
    lingerSeconds: 1,
    log: () => {},
  });
  await forwarder.start();

  const started = Date.now();
  const out = await halfCloseClient(listenPort);
  const elapsed = Date.now() - started;

  expect(out).not.toContain("TIMEOUT"); // it got a real EOF, not a client-side give-up
  expect(elapsed).toBeLessThan(7_000);
  silent.stop();
}, 20_000);
