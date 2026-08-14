/**
 * Automatic apply: the debounce/coalesce state machine that turns "the user just changed
 * something that needs root" into AT MOST ONE macOS admin prompt.
 *
 * See docs/AUTOAPPLY.md. This module owns the policy and nothing else — it does no I/O,
 * imports no other dashboard module, and never runs a privileged command. Everything it
 * touches (the clock, the timer, the tray heartbeat, writing the request, reading the
 * result) arrives as an injected dependency, so the whole thing is unit-testable without
 * a filesystem, a timer, or the slightest chance of a real password dialog.
 *
 * The four rules it exists to enforce, in order of how bad it is to break them:
 *
 *   1. NEVER LOOP ON CANCEL. A `cancelled` result parks the machine in `deferred`. It does
 *      not re-queue and it does not schedule a retry. A password dialog that reappears
 *      because you dismissed it is malware behaviour. Only a NEW user mutation, or an
 *      explicit user action, may queue again.
 *   2. NEVER PROMPT WITHOUT A USER-INITIATED CAUSE. `notifyMutation` is the ONLY entry
 *      point that can lead to a queue, and the service layer calls it only after a
 *      mutation a user just made. Polling, startup reconciliation and drift found after a
 *      reboot go through `status()`, which can never queue on its own.
 *   3. COALESCE. Mutations restart a debounce window; when it expires exactly one request
 *      is queued. Apply is a full idempotent desired-state reconcile, so one request
 *      always covers everything pending — three aliases added in a second are one prompt.
 *   4. ONE IN FLIGHT. While a privileged run is in flight further mutations only mark the
 *      machine dirty; they are picked up after it finishes rather than queuing a second
 *      prompt.
 *
 * A failed (not cancelled) result parks in `failed` for the same reason as cancel: a run
 * that keeps failing must not keep prompting.
 */
import { APPLY_REQUEST_TTL_MS, type PrivilegedRequest, type PrivilegedResult } from "@localhost-aliases/core";

/** Quiet period after the last mutation before the single request is queued. */
export const AUTO_APPLY_DEBOUNCE_MS = 1_500;

export type AutoApplyState =
  /** Nothing pending. */
  | "idle"
  /** A mutation needing root landed; the coalesced request is queued when the window closes. */
  | "scheduled"
  /** A request is in flight; the admin prompt is up or about to be. */
  | "prompting"
  /** The user dismissed the prompt. Parked on purpose — nothing re-queues on its own. */
  | "deferred"
  /** The privileged run reported an error. Also parked; only a user may try again. */
  | "failed";

/** What the state endpoint hands the UI so it can be honest about what is happening. */
export interface AutoApplyStatus {
  state: AutoApplyState;
  /** config.autoApply, as last seen by the scheduler. */
  enabled: boolean;
  /** The request currently in flight, when there is one. */
  requestId: string | null;
  /** Milliseconds until the coalesced request is queued, while `scheduled`. */
  scheduledInMs: number | null;
  /** A mutation landed during an in-flight run and will be picked up after it. */
  dirty: boolean;
  /** The real error from a failed run. Never a generic one. */
  error: string | null;
  /** Plain-language explanation of why the machine is where it is. */
  reason: string | null;
}

/** Everything the scheduler needs from the outside world. All of it stubbed in tests. */
export interface AutoApplyDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Is the menu-bar app's heartbeat fresh? Nothing is queued when it is not. */
  trayAlive(): Promise<boolean>;
  /** Refresh the runtime files and write the request file. The ONLY thing that can prompt. */
  queue(): Promise<PrivilegedRequest>;
  /** The result for a request id, or null while it is unanswered. */
  readResult(id: string): Promise<PrivilegedResult | null>;
}

export interface AutoApplyOptions {
  debounceMs?: number;
  /** After this long with no result the in-flight run is written off, not retried. */
  inFlightTtlMs?: number;
}

const TRAY_DOWN =
  "The Localhost Aliases menu-bar app is not running, so nothing would pick this up.";
const DISABLED = "Automatic apply is off; apply the changes yourself when you are ready.";
const CANCELLED =
  "You dismissed the administrator prompt. Nothing is applied until you ask again — the change itself is saved.";
const UNANSWERED = "The menu-bar app never answered the request. Nothing was applied.";

export interface MutationSignal {
  /** True when the current desired state cannot be reached without root. */
  needsRoot: boolean;
}

export class AutoApply {
  private readonly deps: AutoApplyDeps;
  private readonly debounceMs: number;
  private readonly inFlightTtlMs: number;

  private state: AutoApplyState = "idle";
  private enabled = true;
  private timer: unknown = null;
  private firesAt = 0;
  private requestId: string | null = null;
  private promptedAt = 0;
  private dirty = false;
  private error: string | null = null;
  private reason: string | null = null;

  /**
   * One work queue for every async transition. Route handlers run concurrently, so
   * without it a mutation and a poll could interleave halfway through a transition and
   * lose the "one in flight" guarantee.
   */
  private work: Promise<void> = Promise.resolve();

  constructor(deps: AutoApplyDeps, options: AutoApplyOptions = {}) {
    this.deps = deps;
    this.debounceMs = options.debounceMs ?? AUTO_APPLY_DEBOUNCE_MS;
    this.inFlightTtlMs = options.inFlightTtlMs ?? APPLY_REQUEST_TTL_MS;
  }

  // --- public API -----------------------------------------------------------

  /**
   * Tell the scheduler what config.autoApply says. Turning it off immediately cancels a
   * pending window and drops the dirty flag: with the setting off the product behaves
   * exactly as it did before this feature existed.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) return;
    this.cancelTimer();
    this.dirty = false;
    if (this.state === "scheduled") {
      this.state = "idle";
      this.reason = DISABLED;
    }
  }

  /**
   * The ONLY path that can lead to an admin prompt. Called by the service layer after a
   * mutation the user just made, never from a poll and never from startup.
   */
  notifyMutation(signal: MutationSignal): Promise<AutoApplyStatus> {
    return this.run(() => this.onMutation(signal));
  }

  /**
   * Read the machine's state, settling any in-flight request first. Safe to call from a
   * poll: it can finish a run, but it can never start one.
   */
  status(): Promise<AutoApplyStatus> {
    return this.run(() => this.settle());
  }

  /**
   * The user clicked "Prepare and apply" themselves. That is an explicit user action, so
   * it clears `deferred`/`failed` and takes over as the in-flight run.
   */
  noteExplicitRequest(request: PrivilegedRequest): Promise<AutoApplyStatus> {
    return this.run(async () => {
      this.cancelTimer();
      this.state = "prompting";
      this.requestId = request.id;
      this.promptedAt = this.deps.now();
      this.dirty = false;
      this.error = null;
      this.reason = null;
    });
  }

  /** Resolves once every transition queued so far has finished. Used by tests. */
  whenSettled(): Promise<void> {
    return this.work;
  }

  /** Synchronous read, with no settling. */
  snapshot(): AutoApplyStatus {
    return {
      state: this.state,
      enabled: this.enabled,
      requestId: this.requestId,
      scheduledInMs: this.state === "scheduled" ? Math.max(0, this.firesAt - this.deps.now()) : null,
      dirty: this.dirty,
      error: this.error,
      reason: this.reason,
    };
  }

  // --- transitions ----------------------------------------------------------

  private async onMutation(signal: MutationSignal): Promise<void> {
    await this.settle();

    if (!this.enabled) {
      // Rule: with the setting off, a mutation changes nothing about prompting.
      this.reason = this.state === "idle" ? DISABLED : this.reason;
      return;
    }

    // Nothing here needs root: writing routes.json already made it live. A window that
    // was already open for an earlier change is deliberately left running.
    if (!signal.needsRoot) return;

    // Rule: one in flight. The mutation is remembered, not queued.
    if (this.state === "prompting") {
      this.dirty = true;
      return;
    }

    if (!(await this.trayAlive())) return;

    this.schedule();
  }

  private schedule(): void {
    this.cancelTimer();
    this.state = "scheduled";
    this.error = null;
    this.reason = null;
    this.firesAt = this.deps.now() + this.debounceMs;
    this.timer = this.deps.setTimer(() => {
      void this.run(() => this.fire());
    }, this.debounceMs);
  }

  /** The debounce window closed: queue exactly one request for everything pending. */
  private async fire(): Promise<void> {
    this.timer = null;
    if (this.state !== "scheduled") return;
    if (!this.enabled) {
      this.state = "idle";
      this.reason = DISABLED;
      return;
    }
    if (!(await this.trayAlive())) return;

    try {
      const request = await this.deps.queue();
      this.state = "prompting";
      this.requestId = request.id;
      this.promptedAt = this.deps.now();
      this.dirty = false;
      this.error = null;
      this.reason = null;
    } catch (error) {
      this.state = "failed";
      this.requestId = null;
      this.error = error instanceof Error ? error.message : String(error);
      this.reason = this.error;
    }
  }

  /**
   * Resolve an in-flight run. This is where the never-loop rule is enforced: a cancelled
   * or failed result parks the machine, and only a mutation that landed WHILE the run was
   * in flight (a real user action) is allowed to open a fresh window.
   */
  private async settle(): Promise<void> {
    if (this.state !== "prompting" || this.requestId === null) return;

    let result: PrivilegedResult | null = null;
    try {
      result = await this.deps.readResult(this.requestId);
    } catch {
      result = null;
    }

    if (!result) {
      if (this.deps.now() - this.promptedAt > this.inFlightTtlMs) {
        this.state = "failed";
        this.requestId = null;
        this.dirty = false;
        this.error = UNANSWERED;
        this.reason = UNANSWERED;
      }
      return;
    }

    this.requestId = null;

    if (result.cancelled) {
      // RULE 1. Park. No re-queue, no retry, no timer.
      this.state = "deferred";
      this.dirty = false;
      this.error = null;
      this.reason = CANCELLED;
      return;
    }

    if (!result.ok) {
      this.state = "failed";
      this.dirty = false;
      this.error = result.error ?? "The privileged apply failed.";
      this.reason = this.error;
      return;
    }

    this.error = null;
    this.reason = null;
    if (this.enabled && this.dirty) {
      // A user mutation landed mid-run, so there is a user-initiated cause for one more
      // window. `dirty` is only ever set by notifyMutation, never by a poll.
      this.dirty = false;
      this.schedule();
      return;
    }
    this.state = "idle";
  }

  // --- plumbing -------------------------------------------------------------

  private async trayAlive(): Promise<boolean> {
    let alive = false;
    try {
      alive = await this.deps.trayAlive();
    } catch {
      alive = false;
    }
    if (alive) return true;

    // Nothing would ever read the request file, so queuing one would leave the UI waiting
    // on a prompt that is never going to appear.
    this.cancelTimer();
    if (this.state === "scheduled") this.state = "idle";
    this.reason = TRAY_DOWN;
    return false;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private run(fn: () => Promise<void>): Promise<AutoApplyStatus> {
    const next = this.work.then(fn, fn);
    this.work = next.then(
      () => undefined,
      () => undefined,
    );
    return this.work.then(() => this.snapshot());
  }
}

export function createAutoApply(deps: AutoApplyDeps, options: AutoApplyOptions = {}): AutoApply {
  return new AutoApply(deps, options);
}
