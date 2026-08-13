/**
 * Test rig. Everything binds 127.0.0.1 on ports above 1024: no privileged port, no lo0
 * alias, no /etc/hosts. The forwarder takes its listen port from the route, which is what
 * makes an unprivileged test of a root component possible at all.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "@localhost-aliases/core/types";

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "la-forwarder-"));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A port nothing is using right now. */
export function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

export async function writeRoutes(path: string, routes: Route[]): Promise<void> {
  await Bun.write(path, `${JSON.stringify(routes, null, 2)}\n`);
}

export function route(listenPort: number, targetPort: number, hostname = "test.local"): Route {
  return { ip: "127.0.0.1", listenPort, targetPort, hostname };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 3_000, stepMs = 10, what = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Deterministic filler so a corrupted byte anywhere changes the hash. */
export function payload(size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

/**
 * A one-shot HTTP GET over a fresh connection. `fetch` keeps connections alive and would
 * reuse a tunnel that is already spliced to the old target, which says nothing about what a
 * reload did — a retarget only ever applies to new connections.
 */
export async function httpGet(port: number, path = "/"): Promise<string> {
  const chunks: Uint8Array[] = [];
  let done = false;
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        chunks.push(new Uint8Array(d));
      },
      close() {
        done = true;
      },
      end() {
        done = true;
      },
    },
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: forwarder-test\r\nConnection: close\r\n\r\n`);
  await waitFor(() => done, { what: `a response from 127.0.0.1:${port}` });
  const text = Buffer.concat(chunks).toString("utf8");
  const headerEnd = text.indexOf("\r\n\r\n");
  return headerEnd === -1 ? text : text.slice(headerEnd + 4);
}

/** True when nothing is listening on the port. */
export async function isRefused(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.terminate();
    return false;
  } catch {
    return true;
  }
}

/** Raw TCP echo server — no protocol at all, which is the point of the forwarder. */
export function rawEcho(): { port: number; closes: number; stop(): void } {
  const state = { port: 0, closes: 0, stop: () => {} };
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
      close() {
        state.closes += 1;
      },
    },
  });
  state.port = server.port;
  state.stop = () => server.stop(true);
  return state;
}
