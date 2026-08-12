/**
 * The HTTPS leg, proven end to end for real.
 *
 * The whole chain runs, nothing is stubbed:
 *
 *   config.https = true  ->  core issueLeaf()  ->  ApplyRequest over the control socket
 *   ->  the helper binds its TLS listener  ->  curl speaks real TLS to an alias hostname
 *   ->  the request reaches the upstream dev server.
 *
 * `curl --cacert` verifies against the generated local CA, so the System keychain is never
 * touched and no sudo is involved; `--resolve` maps the alias hostname to 127.0.0.1 without
 * DNS or /etc/hosts. Ports are unprivileged, the config dir and hosts file are temp files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildApplyRequest,
  buildRoutes,
  caCertPath,
  createAlias,
  helperApply,
  helperStatus,
  issueLeaf,
  leafCertPath,
  loadConfig,
  updateSettings,
  type ApplyRequest,
  type Config,
  type HelperStatus,
} from "@localhost-aliases/core";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const OPENSSL = "/usr/bin/openssl";
/** Generating the CA on a cold machine dominates this suite. */
const SLOW = 120_000;

// sun_path caps a unix socket path at ~104 bytes, so the run dir lives directly under /tmp.
const runDir = mkdtempSync("/tmp/la-https-");
const socket = join(runDir, "h.sock");
const hostsFile = join(runDir, "hosts");

// Read by core (store, certs, helper-client) in this process and by the helper child.
process.env.LA_CONFIG_DIR = runDir;
process.env.LA_HOSTS_PATH = hostsFile;
process.env.LA_SOCKET_PATH = socket;

let helper: Subprocess<"ignore", "pipe", "pipe">;
let shop: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof Bun.serve>;
let httpPort = 0;
let httpsPort = 0;
let deadPort = 0;
const logs: string[] = [];

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

/** 18443 when it is free, as documented; any free port otherwise so CI never collides. */
function preferredHttpsPort(): number {
  try {
    const probe = Bun.serve({ port: 18443, hostname: "127.0.0.1", fetch: () => new Response("") });
    probe.stop(true);
    return 18443;
  } catch {
    return freePort();
  }
}

interface CurlResult {
  exitCode: number;
  status: number;
  body: string;
  headers: string;
  stderr: string;
}

/** One real TLS request to `host`, verified against our own CA and nothing else. */
function curl(host: string, path = "/", extra: string[] = []): CurlResult {
  const marker = "\n<<<status:";
  const proc = Bun.spawnSync([
    "curl",
    "-sS",
    "--cacert",
    caCertPath(),
    "--resolve",
    `${host}:${httpsPort}:127.0.0.1`,
    "-D",
    "-", // response headers first, then the body
    "-w",
    `${marker}%{http_code}>>>`,
    ...extra,
    `https://${host}:${httpsPort}${path}`,
  ]);
  const out = proc.stdout.toString();
  const status = Number(/<<<status:(\d+)>>>/.exec(out)?.[1] ?? 0);
  const payload = out.slice(0, out.lastIndexOf(marker) === -1 ? undefined : out.lastIndexOf(marker));
  const split = payload.indexOf("\r\n\r\n");
  return {
    exitCode: proc.exitCode ?? -1,
    status,
    headers: split === -1 ? "" : payload.slice(0, split),
    body: split === -1 ? payload : payload.slice(split + 4),
    stderr: proc.stderr.toString(),
  };
}

async function control(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`http://localhost${path}`, { ...init, unix: socket });
}

async function apply(request: ApplyRequest): Promise<void> {
  const result = await helperApply(request);
  if (!result.ok) throw new Error(`apply failed: ${result.error}\n${logs.join("")}`);
}

/** Exactly what packages/web's `pushDesiredState` does, minus the framework. */
async function pushDesiredState(config: Config): Promise<ApplyRequest> {
  const tls = config.https ? await issueLeaf(buildRoutes(config).map((route) => route.host)) : null;
  const request = buildApplyRequest(config, tls);
  await apply(request);
  return request;
}

function certText(): string {
  return Bun.spawnSync([OPENSSL, "x509", "-in", leafCertPath(), "-noout", "-text"]).stdout.toString();
}

beforeAll(async () => {
  await Bun.write(hostsFile, "##\n# Host Database\n#\n127.0.0.1\tlocalhost\n");
  httpPort = freePort();
  httpsPort = preferredHttpsPort();
  deadPort = freePort(); // freed immediately: nothing listens there, which is the point

  shop = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      Response.json({
        upstream: "shop",
        path: new URL(req.url).pathname,
        host: req.headers.get("host"),
        proto: req.headers.get("x-forwarded-proto"),
        forwardedHost: req.headers.get("x-forwarded-host"),
      }),
  });
  api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ upstream: "api" }) });

  await updateSettings({ https: true, httpPort, httpsPort });
  await createAlias({ name: "shop", port: Number(shop.port) });
  await createAlias({ name: "api", port: Number(api.port) });
  await createAlias({ name: "dead", port: deadPort });

  helper = Bun.spawn([process.execPath, "run", ENTRY], {
    env: { ...process.env, LA_HTTP_PORT: String(httpPort), LA_HTTPS_PORT: String(httpsPort) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [helper.stdout, helper.stderr]) {
    void (async () => {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        logs.push(new TextDecoder().decode(value));
      }
    })();
  }

  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await helperStatus();
    if (status.ok) break;
    if (Date.now() > deadline) throw new Error(`the helper never answered\n${logs.join("")}`);
    await Bun.sleep(50);
  }

  await pushDesiredState(await loadConfig());
}, SLOW);

afterAll(async () => {
  helper?.kill();
  await helper?.exited;
  shop?.stop(true);
  api?.stop(true);
  rmSync(runDir, { recursive: true, force: true });
});

describe("issuing", () => {
  test("the CA and the leaf were generated inside the temp config dir", () => {
    expect(existsSync(caCertPath())).toBe(true);
    expect(caCertPath().startsWith(runDir)).toBe(true);
    expect(existsSync(leafCertPath())).toBe(true);
  });

  test("the SAN list covers every alias hostname, not just the first", () => {
    const text = certText();
    const sans = /X509v3 Subject Alternative Name:\s*\n\s*(.+)/.exec(text)?.[1] ?? "";
    for (const host of ["shop.local", "api.local", "dead.local"]) {
      expect(sans).toContain(`DNS:${host}`);
    }
    expect(sans).toContain("DNS:localhost");
    expect(sans).toContain("IP Address:127.0.0.1");
    expect(text).toContain("TLS Web Server Authentication");
  });

  test("the leaf chains to the generated CA", () => {
    const verify = Bun.spawnSync([OPENSSL, "verify", "-CAfile", caCertPath(), leafCertPath()]);
    expect(verify.exitCode).toBe(0);
  });
});

describe("the TLS listener", () => {
  test("is bound on the configured https port", async () => {
    const status = (await (await control("/status")).json()) as HelperStatus;
    expect(status.https).toEqual({ listening: true, port: httpsPort });
    expect(status.http.listening).toBe(true);
    expect(status.managedHosts).toEqual(["api.local", "dead.local", "shop.local"]);
  });

  test("the managed hosts block went to the temp file, never /etc/hosts", async () => {
    const content = await Bun.file(hostsFile).text();
    expect(content).toContain("127.0.0.1\tshop.local");
    expect(content).toContain("::1\tapi.local");
  });
});

describe("HTTPS through the proxy", () => {
  test("an alias hostname reaches its upstream over real TLS", () => {
    const res = curl("shop.local", "/checkout?step=2");
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    expect(res.status).toBe(200);
    const seen = JSON.parse(res.body);
    expect(seen.upstream).toBe("shop");
    expect(seen.path).toBe("/checkout");
    // The proxy tells the dev server it was reached over TLS, and on which name.
    expect(seen.proto).toBe("https");
    expect(seen.host).toBe(`shop.local:${httpsPort}`);
    expect(seen.forwardedHost).toBe(`shop.local:${httpsPort}`);
  });

  test("a second alias on the same listener and the same certificate also verifies", () => {
    const res = curl("api.local", "/");
    expect(res.stderr).toBe("");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).upstream).toBe("api");
  });

  test("a POST body survives the TLS hop", () => {
    const res = curl("shop.local", "/cart", ["-X", "POST", "-d", "qty=3"]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).path).toBe("/cart");
  });

  test("a hostname outside the SAN list is refused by the client, as it must be", () => {
    const res = curl("nowhere.local");
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("certificate subject name");
  });

  test("the same aliases still answer over plain HTTP", async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/`, { headers: { host: "shop.local" } });
    expect(res.status).toBe(200);
    expect((await res.json()).proto).toBe("http");
  });
});

describe("the branded pages over HTTPS", () => {
  test("a known alias with nothing listening gets the auto-refreshing offline page", () => {
    const res = curl("dead.local", "/anything");
    expect(res.exitCode).toBe(0);
    expect(res.status).toBe(502);
    expect(res.headers.toLowerCase()).toContain("retry-after: 3");
    expect(res.body).toContain('<meta http-equiv="refresh" content="3">');
    expect(res.body).toContain(`nothing is listening on 127.0.0.1:${deadPort}`);
    expect(res.body).toContain("dead.local");
    expect(res.body).toContain("prefers-color-scheme");
  });

  test("a host that is not an alias gets the 404 page listing the ones that are", () => {
    // `localhost` is always in the SAN list, so TLS succeeds and the routing layer answers:
    // exactly what someone hitting the proxy port directly sees.
    const res = curl("localhost", "/");
    expect(res.exitCode).toBe(0);
    expect(res.status).toBe(404);
    expect(res.body).toContain("localhost");
    expect(res.body).toContain("shop.local");
    expect(res.body).toContain("api.local");
    expect(res.body).toContain("dead.local");
  });
});

describe("re-applying", () => {
  test("an unchanged config reuses the certificate and does not rebind the listener", async () => {
    const before = logs.join("").split('"proto":"https"').length;
    await pushDesiredState(await loadConfig());
    // A fresh leaf on every apply would swap the TLS material and force a rebind, dropping
    // every live HTTPS connection on each alias edit. Same SANs must mean same certificate.
    expect(logs.join("").split('"proto":"https"').length).toBe(before);
    expect(curl("shop.local").status).toBe(200);
  }, SLOW);

  test("adding an alias reissues the certificate to cover it", async () => {
    const extra = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("extra") });
    try {
      await createAlias({ name: "extra", port: Number(extra.port) });
      await pushDesiredState(await loadConfig());
      expect(certText()).toContain("DNS:extra.local");
      const res = curl("extra.local", "/");
      expect(res.stderr).toBe("");
      expect(res.status).toBe(200);
      expect(res.body).toBe("extra");
    } finally {
      extra.stop(true);
    }
  }, SLOW);
});

describe("turning HTTPS off", () => {
  test("clears the TLS material and stops the listener", async () => {
    const config = await updateSettings({ https: false });
    const request = await pushDesiredState(config);
    expect(request.tls).toBeNull();

    const status = (await (await control("/status")).json()) as HelperStatus;
    expect(status.https.listening).toBe(false);

    const res = curl("shop.local");
    expect(res.exitCode).not.toBe(0);
    // Plain HTTP keeps working: turning TLS off must not take the proxy down.
    const plain = await fetch(`http://127.0.0.1:${httpPort}/`, { headers: { host: "shop.local" } });
    expect(plain.status).toBe(200);
  }, SLOW);
});
