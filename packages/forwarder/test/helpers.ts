/**
 * Test rig. Everything binds 127.0.0.1 on ports above 1024: no privileged port, no lo0
 * alias, no /etc/hosts. The forwarder takes its listen port from the route, which is what
 * makes an unprivileged test of a root component possible at all.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "@localhost-aliases/core/types";
import { isPoolIp } from "@localhost-aliases/core/ips";
import type { SystemOps } from "../src/system.ts";

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

export function route(listenPort: number, targetPort: number, hostname = "test.test"): Route {
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

/**
 * A recording stand-in for everything the agent can do to the machine.
 *
 * NOTHING in the agent tests may run ifconfig, write /etc/hosts or flush DNS, so the real
 * SystemOps is never constructed: this is. It keeps the same invariants the real one does
 * (a non-pool address is refused) so a test that would have escalated still fails here.
 */
export interface FakeSystem extends SystemOps {
  lo0: string[];
  hosts: string;
  calls: string[];
  /** Set to make the next call of that name throw, as a wedged machine would. */
  failNext: Set<string>;
  hostsWrites: number;
}

export function fakeSystem(options: { lo0?: string[]; hosts?: string } = {}): FakeSystem {
  const self: FakeSystem = {
    lo0: [...(options.lo0 ?? ["127.0.0.1"])],
    hosts: options.hosts ?? SYSTEM_HOSTS,
    calls: [],
    failNext: new Set(),
    hostsWrites: 0,

    async listLoopbackIps() {
      self.calls.push("list");
      if (self.failNext.delete("list")) throw new Error("ifconfig is wedged");
      return [...self.lo0];
    },
    async addLoopbackIp(ip) {
      self.calls.push(`add ${ip}`);
      if (self.failNext.delete("add")) throw new Error("ifconfig refused");
      if (!isPoolIp(ip)) throw new Error(`refusing to add ${ip}: outside 127.0.0.2-254`);
      if (!self.lo0.includes(ip)) self.lo0.push(ip);
    },
    async removeLoopbackIp(ip) {
      self.calls.push(`remove ${ip}`);
      if (self.failNext.delete("remove")) throw new Error("ifconfig refused");
      if (!isPoolIp(ip)) throw new Error(`refusing to remove ${ip}: outside 127.0.0.2-254`);
      self.lo0 = self.lo0.filter((x) => x !== ip);
    },
    async readHosts() {
      self.calls.push("readHosts");
      if (self.failNext.delete("readHosts")) throw new Error("hosts is unreadable");
      return self.hosts;
    },
    async writeHosts(content) {
      self.calls.push("writeHosts");
      if (self.failNext.delete("writeHosts")) throw new Error("hosts is read-only");
      self.hosts = content;
      self.hostsWrites += 1;
    },
    async flushDns() {
      self.calls.push("flushDns");
    },
  };
  return self;
}

/** A believable /etc/hosts, so "nothing outside the markers changed" means something. */
export const SYSTEM_HOSTS = [
  "##",
  "# Host Database",
  "##",
  "127.0.0.1\tlocalhost",
  "255.255.255.255\tbroadcasthost",
  "::1             localhost",
  "",
].join("\n");

/** The shape the dashboard writes. Tests mutate it into hostile variants. */
export function desiredState(
  overrides: Partial<{ hosts: unknown[]; loopbackIps: unknown[]; routes: unknown[] }> = {},
): Record<string, unknown> {
  return {
    hosts: [
      { ip: "127.0.0.2", hostname: "index.test" },
      { ip: "127.0.0.3", hostname: "myapp.test" },
    ],
    loopbackIps: ["127.0.0.2", "127.0.0.3"],
    routes: [
      { ip: "127.0.0.2", listenPort: 80, targetPort: 7788, hostname: "index.test" },
      { ip: "127.0.0.3", listenPort: 80, targetPort: 3000, hostname: "myapp.test" },
    ],
    ...overrides,
  };
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
