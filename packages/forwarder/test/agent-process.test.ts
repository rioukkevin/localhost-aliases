/**
 * The real entrypoint, running as the ROOT AGENT — and never as root.
 *
 * How that is possible, and why it is still a real test:
 *   - `ifconfig`, `dscacheutil` and `killall` are stub scripts in a temp directory, pinned
 *     through LA_IFCONFIG / LA_DSCACHEUTIL / LA_KILLALL so even a PATH accident cannot reach
 *     the real binaries. The stub keeps its own list of "lo0 addresses" in a file.
 *   - `/etc/hosts` is LA_HOSTS_PATH, a file in that same temp directory.
 *   - routes bind 127.0.0.1 on ports above 1024, taken from the desired state.
 *   - LA_AGENT_RECONCILE=1 is what turns reconciliation on without being uid 0.
 *
 * So this exercises the whole thing the tray will run — spawn, reconcile, watch, exit — with
 * nothing on this machine to put back afterwards.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HOSTS_BEGIN, HOSTS_END } from "@localhost-aliases/core/types";
import { cleanup, freePort, httpGet, tempDir, waitFor } from "./helpers.ts";

const entry = join(import.meta.dir, "..", "src", "index.ts");
const bun = Bun.which("bun") ?? "bun";

const SYSTEM_HOSTS = ["##", "# Host Database", "##", "127.0.0.1\tlocalhost", "255.255.255.255\tbroadcasthost", ""].join("\n");

let child: Bun.Subprocess | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let dir = "";
let beating: ReturnType<typeof setInterval> | null = null;

afterEach(async () => {
  if (beating) clearInterval(beating);
  beating = null;
  // Only ever the process we started ourselves, by handle. Never by name, never by pattern.
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = null;
  upstream?.stop(true);
  upstream = null;
  if (dir) await cleanup(dir);
  dir = "";
});

interface Rig {
  stateFile: string;
  hostsPath: string;
  livenessFile: string;
  statusFile: string;
  listenPort: number;
  lo0(): string[];
  hosts(): string;
  ifconfigCalls(): string[];
  dnsCalls(): string[];
  writeState(state: unknown): void;
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

const q = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

/** A sandbox whose "machine" is three files. */
async function rig(): Promise<Rig> {
  dir = await tempDir();
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });

  const ipsFile = join(dir, "lo0-ips");
  writeFileSync(ipsFile, "127.0.0.1\n");
  const calls = (name: string) => join(dir, `${name}.calls`);
  for (const name of ["ifconfig", "dscacheutil", "killall"]) writeFileSync(calls(name), "");

  script(
    join(binDir, "ifconfig"),
    `printf '%s\\n' "$*" >> ${q(calls("ifconfig"))}
case "\${2:-}" in
  alias)  grep -qx "$3" ${q(ipsFile)} || printf '%s\\n' "$3" >> ${q(ipsFile)} ;;
  -alias) grep -vx "$3" ${q(ipsFile)} > ${q(ipsFile)}.tmp || true; mv ${q(ipsFile)}.tmp ${q(ipsFile)} ;;
  *)
    printf 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\\n'
    while read -r ip; do printf '\\tinet %s netmask 0xff000000\\n' "$ip"; done < ${q(ipsFile)} ;;
esac
exit 0`,
  );
  script(join(binDir, "dscacheutil"), `printf '%s\\n' "$*" >> ${q(calls("dscacheutil"))}\nexit 0`);
  script(join(binDir, "killall"), `printf '%s\\n' "$*" >> ${q(calls("killall"))}\nexit 0`);

  const hostsPath = join(dir, "hosts");
  writeFileSync(hostsPath, SYSTEM_HOSTS);
  const stateFile = join(dir, "desired-state.json");

  return {
    stateFile,
    hostsPath,
    livenessFile: join(dir, "liveness"),
    statusFile: join(dir, "forwarder-status.json"),
    listenPort: freePort(),
    lo0: () => readFileSync(ipsFile, "utf8").split("\n").filter(Boolean),
    hosts: () => readFileSync(hostsPath, "utf8"),
    ifconfigCalls: () => readFileSync(calls("ifconfig"), "utf8").split("\n").filter(Boolean),
    dnsCalls: () => [
      ...readFileSync(calls("dscacheutil"), "utf8").split("\n").filter(Boolean),
      ...readFileSync(calls("killall"), "utf8").split("\n").filter(Boolean),
    ],
    writeState: (state) => writeFileSync(stateFile, JSON.stringify(state, null, 2)),
  };
}

function launch(r: Rig): void {
  writeFileSync(r.livenessFile, String(Date.now()));
  beating = setInterval(() => writeFileSync(r.livenessFile, String(Date.now())), 40);

  const binDir = join(dir, "bin");
  child = Bun.spawn([bun, "run", entry], {
    env: {
      ...process.env,
      LA_CONFIG_DIR: dir,
      LA_HOSTS_PATH: r.hostsPath,
      // The whole point: reconcile without being uid 0, against stubs.
      LA_AGENT_RECONCILE: "1",
      LA_IFCONFIG: join(binDir, "ifconfig"),
      LA_DSCACHEUTIL: join(binDir, "dscacheutil"),
      LA_KILLALL: join(binDir, "killall"),
      NODE_ENV: "production", // this test process runs with NODE_ENV=test; the tray does not
      LA_LIVENESS_INTERVAL_MS: "50",
      LA_LIVENESS_TIMEOUT_MS: "200",
      LA_FORWARDER_QUIET: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

const block = (...lines: string[]): string =>
  `${HOSTS_BEGIN}\n${lines.map((l) => `${l}\n`).join("")}${HOSTS_END}\n`;

/**
 * Wait until the route really answers. Binding is the LAST step of a reconcile pass, so
 * this is also the signal that the pass finished — asserting on lo0 or the DNS flush any
 * earlier is a race against a process that is still working.
 */
async function answers(port: number, body: string): Promise<void> {
  await waitFor(async () => (await httpGet(port).catch(() => "")) === body, {
    timeoutMs: 15_000,
    what: `127.0.0.1:${port} to forward "${body}"`,
  });
}

test("it reconciles the desired state at launch, then again on every change, with no prompt", async () => {
  const r = await rig();
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("the app") });
  r.writeState({
    hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
    loopbackIps: ["127.0.0.2"],
    routes: [{ ip: "127.0.0.1", listenPort: r.listenPort, targetPort: upstream.port!, hostname: "myapp.test" }],
  });

  launch(r);
  await waitFor(() => Bun.file(r.statusFile).exists(), { timeoutMs: 15_000, what: "the agent to publish status" });
  await answers(r.listenPort, "the app");

  expect(r.lo0()).toEqual(["127.0.0.1", "127.0.0.2"]);
  expect(r.hosts()).toBe(SYSTEM_HOSTS + block("127.0.0.2\tmyapp.test"));
  expect(r.ifconfigCalls()).toContain("lo0 alias 127.0.0.2 netmask 255.255.255.255 up");
  expect(r.dnsCalls()).toEqual(["-flushcache", "-HUP mDNSResponder"]);

  // --- the part the whole task exists for: a second alias, and nobody types a password ---
  const second = freePort();
  r.writeState({
    hosts: [
      { ip: "127.0.0.2", hostname: "myapp.test" },
      { ip: "127.0.0.3", hostname: "shop.test" },
    ],
    loopbackIps: ["127.0.0.2", "127.0.0.3"],
    routes: [
      { ip: "127.0.0.1", listenPort: r.listenPort, targetPort: upstream.port!, hostname: "myapp.test" },
      { ip: "127.0.0.1", listenPort: second, targetPort: upstream.port!, hostname: "shop.test" },
    ],
  });

  await answers(second, "the app");
  expect(r.lo0()).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
  expect(r.hosts()).toBe(SYSTEM_HOSTS + block("127.0.0.2\tmyapp.test", "127.0.0.3\tshop.test"));

  // --- and removing one takes its address and its line away again ---
  r.writeState({
    hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
    loopbackIps: ["127.0.0.2"],
    routes: [{ ip: "127.0.0.1", listenPort: r.listenPort, targetPort: upstream.port!, hostname: "myapp.test" }],
  });
  await waitFor(() => !r.lo0().includes("127.0.0.3"), { timeoutMs: 15_000, what: "127.0.0.3 to be removed" });
  expect(r.hosts()).toBe(SYSTEM_HOSTS + block("127.0.0.2\tmyapp.test"));
}, 60_000);

test("a hostile desired state is refused and the previous state survives, and the agent keeps running", async () => {
  const r = await rig();
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("still here") });
  const good = {
    hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
    loopbackIps: ["127.0.0.2"],
    routes: [{ ip: "127.0.0.1", listenPort: r.listenPort, targetPort: upstream.port!, hostname: "myapp.test" }],
  };
  r.writeState(good);
  launch(r);
  await answers(r.listenPort, "still here");
  const hostsBefore = r.hosts();

  // A newline in a hostname is an attempt to write a second /etc/hosts line as root.
  r.writeState({
    hosts: [{ ip: "127.0.0.2", hostname: "evil.test\n127.0.0.1\tbank.example.com" }],
    loopbackIps: ["127.0.0.2"],
    routes: [],
  });
  await Bun.sleep(400); // long enough for a watcher event and a poll

  expect(r.hosts()).toBe(hostsBefore);
  expect(r.hosts()).not.toContain("bank.example.com");
  expect(r.lo0()).toEqual(["127.0.0.1", "127.0.0.2"]);
  // Refusing is not crashing: the route it already had is still being forwarded.
  expect(await httpGet(r.listenPort)).toBe("still here");
  expect(child!.exitCode).toBeNull();
}, 60_000);

test("it exits on its own when the liveness file goes away, leaving nothing behind", async () => {
  const r = await rig();
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("bye") });
  r.writeState({
    hosts: [{ ip: "127.0.0.2", hostname: "myapp.test" }],
    loopbackIps: ["127.0.0.2"],
    routes: [{ ip: "127.0.0.1", listenPort: r.listenPort, targetPort: upstream.port!, hostname: "myapp.test" }],
  });
  launch(r);
  await answers(r.listenPort, "bye");

  // The app quits: the heartbeat stops and the file is removed. Nothing kills the agent —
  // a user process cannot kill a root one — so it has to notice and go.
  if (beating) clearInterval(beating);
  beating = null;
  await rm(r.livenessFile);

  expect(await child!.exited).toBe(0);
  expect(existsSync(r.statusFile)).toBe(false); // no stale pid for the tray to believe in
  // Nothing is listening any more: the listener went with the process.
  await expect(httpGet(r.listenPort)).rejects.toThrow();
}, 60_000);
