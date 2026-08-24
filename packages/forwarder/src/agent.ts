/**
 * The ROOT AGENT (docs/AGENT.md §1).
 *
 * One admin prompt at app launch starts this process. From then on it watches
 * desired-state.json and reconciles the machine to it — lo0 aliases, the /etc/hosts managed
 * block, a DNS flush and its own forwarding routes — with NO further prompt. It is the same
 * process as the forwarder: one root process, not two.
 *
 * THE FILE IT WATCHES IS USER-WRITABLE AND THIS PROCESS IS ROOT. That is a real local
 * privilege escalation and is documented as such in packages/privileged/README.md. It is
 * bounded by this class refusing to trust the file:
 *
 *   - every field is re-validated on every read, by desired.ts, before anything happens;
 *   - only 127.0.0.2-254 is ever added to or removed from lo0 — 127.0.0.1 cannot reach
 *     ifconfig from here, and neither can any address outside the pool;
 *   - an address the agent did not allocate is never removed (see `owned` below);
 *   - the /etc/hosts write is confined to the marker block: the new content is rendered,
 *     then the OUTSIDE of both versions is compared byte for byte, and a single difference
 *     refuses the write;
 *   - a rejected file changes nothing at all, and says why in the log.
 *
 * Reconciliation is serialized: two file events can never interleave two passes.
 */
import { applyBlock } from "@localhost-aliases/core/hosts";
import { isPoolIp } from "@localhost-aliases/core/ips";
import { HOSTS_PATH, desiredStatePath } from "@localhost-aliases/core/paths";
import type { Forwarder } from "./forwarder.ts";
import { type Logger, stderrLog } from "./log.ts";
import { type SafePlan, parseDesiredState } from "./desired.ts";
import type { SystemOps } from "./system.ts";
import { FileWatcher, describe } from "./watch.ts";

/**
 * Would this rewrite change a single byte outside the managed block?
 *
 * Strip the block from both versions and compare what is left. That remainder is the user's
 * own /etc/hosts — their localhost line, their comments, whatever their VPN wrote — and it
 * must come through a rewrite byte for byte. Exported because it is the check that turns a
 * bug in the rendering into a refusal instead of a mangled /etc/hosts, and a check like that
 * has to be tested against a deliberately corrupted rewrite, not only against a correct one.
 */
export function outsideBlockChanged(current: string, next: string): boolean {
  try {
    return applyBlock(current, []) !== applyBlock(next, []);
  } catch {
    return true; // cannot prove it is safe, so it is not
  }
}

export interface AgentOptions {
  /** The forwarder this agent drives. It must have been built with watchRoutesFile: false. */
  forwarder: Forwarder;
  /** Everything that changes the machine. Injected, so tests never touch one. */
  system: SystemOps;
  desiredStateFile?: string;
  /** Only used in log lines; the writing itself belongs to `system`. */
  hostsPath?: string;
  /**
   * Pool addresses this install allocated, from config.json via LA_MANAGED_IPS. They seed
   * `owned`, so an agent restarted against an lo0 someone else already set up can still
   * clean up after itself. Without it the agent only ever removes what it added or what a
   * desired state has claimed.
   */
  managedIps?: readonly string[];
  pollMs?: number;
  log?: Logger;
}

/** What one pass did. Returned for tests and logged for humans. */
export interface ReconcileResult {
  ok: boolean;
  /** Present when the file was refused; the machine was not touched. */
  rejected: string[];
  added: string[];
  removed: string[];
  hostsChanged: boolean;
  dnsFlushed: boolean;
  routes: number;
}

const NOTHING: Omit<ReconcileResult, "ok" | "rejected"> = {
  added: [],
  removed: [],
  hostsChanged: false,
  dnsFlushed: false,
  routes: 0,
};

export class Agent {
  private readonly forwarder: Forwarder;
  private readonly system: SystemOps;
  private readonly desiredStateFile: string;
  private readonly hostsPath: string;
  private readonly pollMs: number;
  private readonly log: Logger;

  /**
   * Pool addresses this agent is allowed to REMOVE. An address only gets in here by being
   * added by this agent, by appearing in a desired state that passed validation, or by being
   * named in LA_MANAGED_IPS. A 127.0.0.9 the user added by hand for something unrelated is
   * therefore never taken away from them.
   */
  private readonly owned: Set<string>;

  private watcher: FileWatcher | null = null;
  private queue: Promise<ReconcileResult> = Promise.resolve({ ok: true, rejected: [], ...NOTHING });
  private stopped = false;

  constructor(opts: AgentOptions) {
    this.forwarder = opts.forwarder;
    this.system = opts.system;
    this.desiredStateFile = opts.desiredStateFile ?? desiredStatePath();
    this.hostsPath = opts.hostsPath ?? HOSTS_PATH;
    this.pollMs = opts.pollMs ?? 2_000;
    this.log = opts.log ?? stderrLog;
    this.owned = new Set((opts.managedIps ?? []).filter(isPoolIp));
  }

  /** Addresses the agent considers its own. Exposed for tests and for the log line. */
  get ownedIps(): string[] {
    return [...this.owned].sort();
  }

  async start(): Promise<ReconcileResult> {
    const first = await this.reconcile();
    this.watch();
    return first;
  }

  /** One pass, serialized against every other pass. Never throws. */
  reconcile(): Promise<ReconcileResult> {
    this.queue = this.queue.then(() => this.runOnce()).catch((err: Error) => {
      // runOnce is fully guarded; this is the last net, and it must not break the chain.
      this.log(`reconcile failed unexpectedly: ${err.message}`);
      return { ok: false, rejected: [err.message], ...NOTHING };
    });
    return this.queue;
  }

  private async runOnce(): Promise<ReconcileResult> {
    if (this.stopped) return { ok: true, rejected: [], ...NOTHING };
    await this.watcher?.prime();

    let text: string;
    try {
      text = await Bun.file(this.desiredStateFile).text();
    } catch {
      // No file yet, or unreadable. "I have not been told what to do" is not "tear it all
      // down": the previous state stands.
      this.log(`no desired state at ${this.desiredStateFile}; leaving the system as it is`);
      return { ok: false, rejected: ["desired state is missing"], ...NOTHING };
    }
    if (text.trim() === "") {
      this.log("desired state is empty; leaving the system as it is");
      return { ok: false, rejected: ["desired state is empty"], ...NOTHING };
    }

    const { plan, errors, warnings } = parseDesiredState(text);
    for (const warning of warnings) this.log(`desired state: ${warning}`);
    if (!plan) {
      // THE refusal path. Nothing below this line has run, so the machine is untouched.
      this.log(`REFUSED the desired state; the previous state stands (${errors.length} problem(s)):`);
      for (const error of errors) this.log(`  - ${error}`);
      return { ok: false, rejected: [...errors], ...NOTHING };
    }

    for (const ip of plan.loopbackIps) this.owned.add(ip);
    return this.apply(plan);
  }

  /**
   * Order matters:
   *   1. add addresses, so a hostname never resolves to an address that does not exist yet;
   *   2. rewrite /etc/hosts;
   *   3. only then remove addresses, once no name points at them any more.
   */
  private async apply(plan: SafePlan): Promise<ReconcileResult> {
    const added: string[] = [];
    const removed: string[] = [];

    let live: string[];
    try {
      live = await this.system.listLoopbackIps();
    } catch (err) {
      this.log(`could not read lo0: ${describe(err)}; leaving the system as it is`);
      return { ok: false, rejected: [`could not read lo0: ${describe(err)}`], ...NOTHING };
    }

    for (const ip of plan.loopbackIps) {
      if (live.includes(ip)) continue;
      try {
        await this.system.addLoopbackIp(ip);
        added.push(ip);
      } catch (err) {
        // One address failing must not cost the user the other aliases.
        this.log(`could not add ${ip} to lo0: ${describe(err)}`);
      }
    }

    const hostsChanged = await this.writeHosts(plan);

    for (const ip of live) {
      if (!isPoolIp(ip)) continue; // 127.0.0.1 and anything outside the pool is not ours
      if (plan.loopbackIps.includes(ip)) continue;
      if (!this.owned.has(ip)) {
        this.log(`leaving ${ip} on lo0: this agent did not allocate it`);
        continue;
      }
      try {
        await this.system.removeLoopbackIp(ip);
        this.owned.delete(ip);
        removed.push(ip);
      } catch (err) {
        this.log(`could not remove ${ip} from lo0: ${describe(err)}`);
      }
    }

    // Only when a name-to-address mapping actually moved. Flushing on every poll would
    // signal mDNSResponder for nothing.
    const dnsFlushed = added.length > 0 || removed.length > 0 || hostsChanged;
    if (dnsFlushed) await this.system.flushDns();

    await this.forwarder.setRoutes(plan.routes);

    this.log(
      `reconciled: +${added.length} -${removed.length} lo0, hosts ${hostsChanged ? "changed" : "unchanged"}, ` +
        `dns ${dnsFlushed ? "flushed" : "untouched"}, ${plan.routes.length} route(s)`,
    );
    return { ok: true, rejected: [], added, removed, hostsChanged, dnsFlushed, routes: plan.routes.length };
  }

  /**
   * The /etc/hosts half of the boundary.
   *
   * `applyBlock` re-renders the managed block and re-validates every entry as it goes, so a
   * hostname that slipped past desired.ts would still throw here rather than be written. The
   * guard afterwards is the one that matters: strip the managed block from BOTH the current
   * and the proposed file and require the remainder to be byte-identical. If it is not, our
   * own rewrite has touched something outside the markers and the write is refused.
   */
  private async writeHosts(plan: SafePlan): Promise<boolean> {
    let current: string;
    try {
      current = await this.system.readHosts();
    } catch (err) {
      this.log(`could not read ${this.hostsPath}: ${describe(err)}; leaving it alone`);
      return false;
    }

    let next: string;
    try {
      next = applyBlock(current, plan.hosts);
    } catch (err) {
      this.log(`refusing to write ${this.hostsPath}: ${describe(err)}`);
      return false;
    }
    if (next === current) return false;

    if (outsideBlockChanged(current, next)) {
      this.log(`refusing to write ${this.hostsPath}: a byte outside the managed block would change`);
      return false;
    }
    if (current.trim() !== "" && next.trim() === "") {
      this.log(`refusing to write an empty ${this.hostsPath}`);
      return false;
    }

    // Read it once more, immediately before replacing it. `next` was rendered from what the
    // file said a moment ago; if something else edited it since — a manual apply.sh run, an
    // editor, a VPN client — writing `next` would silently revert that edit. Skipping the
    // pass is free: the watcher fires again and the next pass renders from the new content.
    try {
      if ((await this.system.readHosts()) !== current) {
        this.log(`${this.hostsPath} changed while it was being rendered; retrying on the next pass`);
        return false;
      }
    } catch (err) {
      this.log(`could not re-read ${this.hostsPath}: ${describe(err)}; leaving it alone`);
      return false;
    }

    try {
      await this.system.writeHosts(next);
    } catch (err) {
      this.log(`could not write ${this.hostsPath}: ${describe(err)}`);
      return false;
    }
    return true;
  }

  private watch(): void {
    this.watcher = new FileWatcher({
      path: this.desiredStateFile,
      pollMs: this.pollMs,
      log: this.log,
      onChange: () => void this.reconcile(),
    });
    this.watcher.start();
    this.log(`watching ${this.desiredStateFile} for changes; no further prompt is needed`);
  }

  /**
   * Stops watching. It deliberately does NOT undo anything: quitting the app leaves the
   * hosts block and the lo0 addresses in place (that is what `uninstall.sh` is for) and
   * only guarantees that nothing is left RUNNING as root — which is the process exiting.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.stop();
    this.watcher = null;
    await this.queue.catch(() => {});
  }
}
