/**
 * End-to-end test of the real daemon: it is spawned as a subprocess with LA_SOCKET_PATH,
 * LA_HOSTS_PATH and LA_HTTP_PORT pointed at throwaway locations, then driven over the
 * control socket and over real HTTP. Nothing here can reach /var/run or /etc/hosts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ApplyResponse, HelperStatus } from "@localhost-aliases/core";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const ORIGINAL_HOSTS = "##\n# Host Database\n#\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n";

/**
 * Unix socket paths are capped at ~104 bytes by sun_path, and TMPDIR under a sandboxed
 * runner is easily longer than that on its own — so the socket lives directly under /tmp.
 */
const runDir = mkdtempSync("/tmp/la-helper-");
const socket = join(runDir, "h.sock");
const hostsFile = join(runDir, "hosts");

let helper: Subprocess<"ignore", "pipe", "pipe">;
let upstream: ReturnType<typeof Bun.serve>;
let upstreamPort = 0;
let httpPort = 0;
let deadPort = 0;
const stdout: string[] = [];

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

async function control(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`http://localhost${path}`, { ...init, unix: socket });
}

async function apply(body: unknown): Promise<Response> {
  return await control("/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function route(host: string, port: number) {
  return { host, target: "127.0.0.1", port, aliasId: `id-${host}` };
}

async function proxyFetch(host: string, path = "/", init?: RequestInit): Promise<Response> {
  return await fetch(`http://127.0.0.1:${httpPort}${path}`, { ...init, headers: { host, ...(init?.headers ?? {}) } });
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, ms = 10000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${stdout.join("")}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  await Bun.write(hostsFile, ORIGINAL_HOSTS);
  httpPort = freePort();
  deadPort = freePort(); // freed immediately: nothing listens there, which is the point

  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
      const url = new URL(req.url);
      return Response.json({
        method: req.method,
        path: url.pathname + url.search,
        host: req.headers.get("host"),
        xff: req.headers.get("x-forwarded-for"),
        xfproto: req.headers.get("x-forwarded-proto"),
        xfhost: req.headers.get("x-forwarded-host"),
        kept: req.headers.get("x-keep"),
        proxied: req.headers.get("proxy-foo"),
        acceptEncoding: req.headers.get("accept-encoding"),
      });
    },
    websocket: {
      open(ws) { ws.send("hello-from-upstream"); },
      message(ws, message) {
        if (typeof message === "string") ws.send(`echo:${message}`);
        else ws.send(new Uint8Array([...(message as Uint8Array)].map((byte) => byte + 1)));
      },
    },
  });

  upstreamPort = upstream.port ?? 0;

  helper = Bun.spawn([process.execPath, "run", ENTRY], {
    env: {
      ...process.env,
      LA_SOCKET_PATH: socket,
      LA_HOSTS_PATH: hostsFile,
      LA_HTTP_PORT: String(httpPort),
      LA_HTTPS_PORT: String(freePort()),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Both streams feed one buffer: assertions read it, and a failure prints it as context.
  for (const stream of [helper.stdout, helper.stderr]) {
    void (async () => {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        stdout.push(new TextDecoder().decode(value));
      }
    })();
  }

  await waitFor("the helper to answer /status", async () => {
    const res = await control("/status");
    return res.ok ? await res.json() : null;
  });
}, 30000);

afterAll(async () => {
  helper?.kill();
  await helper?.exited;
  upstream?.stop(true);
  rmSync(runDir, { recursive: true, force: true });
});

describe("control socket", () => {
  test("is a socket owned by us with mode 0600", () => {
    const stats = statSync(socket);
    expect(stats.isSocket()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.uid).toBe(process.getuid!());
  });

  test("GET /status before any apply", async () => {
    const status = (await (await control("/status")).json()) as HelperStatus;
    expect(status.ok).toBe(true);
    expect(status.version).toBeString();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.http).toEqual({ listening: true, port: httpPort });
    expect(status.https.listening).toBe(false);
    expect(status.routes).toBe(0);
    expect(status.managedHosts).toEqual([]);
  });

  test("unknown routes and malformed bodies are refused", async () => {
    const missing = await control("/nope");
    expect(missing.status).toBe(404);
    const bad = await control("/apply", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("JSON");
  });
});

describe("apply", () => {
  test("re-validates hostnames and never lets a bad one reach the hosts file", async () => {
    const res = await apply({
      httpPort,
      httpsPort: 1443,
      routes: [{ host: "evil.local\n127.0.0.1 apple.com", target: "127.0.0.1", port: 3000, aliasId: "x" }],
      tls: null,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("is not a valid hostname");
    expect(await Bun.file(hostsFile).text()).toBe(ORIGINAL_HOSTS);
  });

  test("refuses a non-loopback forward target", async () => {
    const res = await apply({ httpPort, httpsPort: 1443, routes: [route("ok.local", 3000)].map((r) => ({ ...r, target: "10.0.0.5" })), tls: null });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("loopback");
    expect(await Bun.file(hostsFile).text()).toBe(ORIGINAL_HOSTS);
  });

  test("writes the managed block, reports the truth, and flushes DNS only on change", async () => {
    const routes = [route("myapp.local", upstreamPort), route("dead.local", deadPort), route("127.0.0.1", upstreamPort)];
    const first = (await (await apply({ httpPort, httpsPort: 1443, routes, tls: null })).json()) as ApplyResponse;
    expect(first.ok).toBe(true);
    expect(first.hostsChanged).toBe(true);
    expect(first.routes).toBe(3);
    // Not running as root, so `killall -HUP mDNSResponder` fails; the response says so.
    expect(first.dnsFlushed).toBe(false);

    const content = await Bun.file(hostsFile).text();
    expect(content.startsWith(ORIGINAL_HOSTS)).toBe(true);
    expect(content).toContain("127.0.0.1\tmyapp.local");
    expect(content).toContain("::1\tdead.local");

    const second = (await (await apply({ httpPort, httpsPort: 1443, routes, tls: null })).json()) as ApplyResponse;
    expect(second.hostsChanged).toBe(false);
    expect(second.dnsFlushed).toBe(false);
    expect(await Bun.file(hostsFile).text()).toBe(content);

    const status = (await (await control("/status")).json()) as HelperStatus;
    expect(status.routes).toBe(3);
    expect(status.managedHosts).toEqual(["127.0.0.1", "dead.local", "myapp.local"]);
  }, 15000);
});

describe("reverse proxy", () => {
  test("routes on the Host header and forwards method, path, body and headers", async () => {
    const res = await proxyFetch("MyApp.local:1234", "/deep/path?q=1", {
      method: "POST",
      body: "payload",
      headers: { "proxy-foo": "bar", "x-keep": "kept" },
    });
    expect(res.status).toBe(200);
    const seen = await res.json();
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/deep/path?q=1");
    // The original Host reaches the dev server, which many of them use to build URLs.
    expect(seen.host).toBe("MyApp.local:1234");
    expect(seen.xfproto).toBe("http");
    expect(seen.xfhost).toBe("MyApp.local:1234");
    expect(seen.xff).toBe("127.0.0.1");
    expect(seen.proxied).toBeNull(); // proxy-* is hop-by-hop
    expect(seen.kept).toBe("kept");
    // Connection-token stripping is asserted in headers.test.ts: Bun's fetch client rewrites
    // the Connection header, so a test cannot forge one over the wire from here.
    expect(seen.acceptEncoding).toBe("identity");
  });

  test("a proxied POST with a body does not poison the next connection", async () => {
    // Regression: forwarding the inbound body as a stream made the *next* fresh connection
    // to the same listener answer an empty 400. curl is used because Bun's fetch would reuse
    // the pooled connection and never open the fresh one that used to break.
    const big = "x".repeat(256 * 1024);
    const echoed = await proxyFetch("myapp.local", "/upload", { method: "POST", body: big });
    expect(echoed.status).toBe(200);
    expect((await echoed.json()).method).toBe("POST");

    const fresh = Bun.spawnSync(["curl", "-sg", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Host: myapp.local", `http://127.0.0.1:${httpPort}/after-post`]);
    expect(fresh.stdout.toString()).toBe("200");
  }, 15000);

  test("an unknown host gets a 404 that lists the known aliases", async () => {
    const res = await proxyFetch("typo.local");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("typo.local");
    expect(html).toContain("myapp.local");
    expect(html).toContain("dead.local");
  });

  test("a known host with nothing listening gets the auto-refreshing offline page", async () => {
    const res = await proxyFetch("dead.local");
    expect(res.status).toBe(502);
    expect(res.headers.get("retry-after")).toBe("3");
    const html = await res.text();
    expect(html).toContain('<meta http-equiv="refresh" content="3">');
    expect(html).toContain(`nothing is listening on 127.0.0.1:${deadPort}`);
    expect(html).toContain("dead.local");
  });

  test("answers on ::1 as well as 127.0.0.1, because the hosts block declares both", async () => {
    const res = await fetch(`http://[::1]:${httpPort}/v6`, { headers: { host: "myapp.local" } });
    expect((await res.json()).path).toBe("/v6");
  });

  test("a WebSocket upgrade with a Host header reaches the right upstream", async () => {
    // Raw handshake: Bun's WebSocket client appends rather than replaces the Host header,
    // so proving Host-based ws routing needs the bytes on the wire.
    const chunks: string[] = [];
    const conn = await Bun.connect({
      hostname: "127.0.0.1",
      port: httpPort,
      socket: { data(_s, data) { chunks.push(new TextDecoder().decode(data)); } },
    });
    conn.write(
      "GET /hmr HTTP/1.1\r\nHost: myapp.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const response = await waitFor("the 101 handshake", async () => (chunks.length > 0 ? chunks.join("") : null), 5000);
    conn.end();
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(response).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    // The upstream greets on open, so seeing it proves the relay is wired both ways.
    expect(response).toContain("hello-from-upstream");
  }, 15000);

  test("relays text frames, binary frames and close codes in both directions", async () => {
    // Routed via the literal-IP route so no Host override is needed (see the note above).
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/hmr`);
    ws.binaryType = "arraybuffer";
    const frames: string[] = [];
    const three = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const data = event.data;
        frames.push(typeof data === "string" ? data : `bin:${[...new Uint8Array(data as ArrayBuffer)].join(",")}`);
        if (frames.length === 3) resolve();
      };
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onclose = (event) => reject(new Error(`closed before open: ${event.code} ${event.reason}`));
      setTimeout(() => reject(new Error("ws did not open")), 5000);
    });
    ws.send("ping");
    ws.send(new Uint8Array([1, 2, 3]));
    await Promise.race([three, Bun.sleep(5000).then(() => Promise.reject(new Error(`only saw ${JSON.stringify(frames)}`)))]);
    expect(frames).toEqual(["hello-from-upstream", "echo:ping", "bin:2,3,4"]);

    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
      ws.close(4001, "bye");
    });
    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe("bye");
  }, 20000);
});

describe("rebinding", () => {
  test("a route-only change does not touch the listeners", async () => {
    const before = stdout.join("").split("listener.").length;
    const res = await apply({
      httpPort,
      httpsPort: 1443,
      routes: [route("myapp.local", upstreamPort), route("dead.local", deadPort), route("127.0.0.1", upstreamPort), route("extra.local", upstreamPort)],
      tls: null,
    });
    expect(res.status).toBe(200);
    expect((await proxyFetch("extra.local")).status).toBe(200);
    expect(stdout.join("").split("listener.").length).toBe(before);
  }, 15000);

  test("a port change rebinds the proxy without dropping the control socket", async () => {
    const next = freePort();
    const res = await apply({ httpPort: next, httpsPort: 1443, routes: [route("myapp.local", upstreamPort)], tls: null });
    expect(res.status).toBe(200);

    const status = (await (await control("/status")).json()) as HelperStatus;
    expect(status.http).toEqual({ listening: true, port: next });

    const moved = await fetch(`http://127.0.0.1:${next}/moved`, { headers: { host: "myapp.local" } });
    expect((await moved.json()).path).toBe("/moved");
    await expect(fetch(`http://127.0.0.1:${httpPort}/`, { headers: { host: "myapp.local" } })).rejects.toThrow();
    httpPort = next;
  }, 15000);
});

describe("apply is transactional", () => {
  /**
   * Regression: the route table used to swap BEFORE the listeners were committed, so a bind
   * failure left the helper serving the new hostnames — which /etc/hosts does not resolve —
   * while the old ones still resolved and 404'd. Every alias broken in the browser until the
   * port conflict cleared.
   *
   * Self-contained: it establishes its own baseline rather than inheriting one from the tests
   * above, so it still proves the invariant when run in isolation with -t.
   */
  test("a failed rebind rolls the route table back instead of half-applying", async () => {
    const baseline = await apply({ httpPort, httpsPort: 1443, routes: [route("base.local", upstreamPort)], tls: null });
    expect(baseline.status).toBe(200);

    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
    const blocked = blocker.port ?? 0;
    try {
      // Ask for a port that cannot be bound, together with a brand new route set.
      const res = await apply({ httpPort: blocked, httpsPort: 1443, routes: [route("rolled.local", upstreamPort)], tls: null });
      expect(res.status).toBeGreaterThanOrEqual(400);

      // The whole request must be rejected: no partial adoption of the new routes.
      const after = (await (await control("/status")).json()) as HelperStatus;
      expect(after.managedHosts).toEqual(["base.local"]);
      expect(after.routes).toBe(1);
      expect(after.http).toEqual({ listening: true, port: httpPort });

      // The old alias still works...
      expect((await (await proxyFetch("base.local", "/still-here")).json()).path).toBe("/still-here");
      // ...and the never-committed one is not served.
      expect((await proxyFetch("rolled.local")).status).toBe(404);
      expect(stdout.join("")).toContain('"evt":"apply.rolledback"');
    } finally {
      blocker.stop(true);
    }
  }, 15000);
});

describe("shutdown", () => {
  test("POST /shutdown answers, stops the listeners and removes the socket", async () => {
    const res = await control("/shutdown", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await helper.exited).toBe(0);
    expect(Bun.file(socket).exists()).resolves.toBe(false);
    expect(stdout.join("")).toContain('"evt":"shutdown"');
  }, 15000);
});
