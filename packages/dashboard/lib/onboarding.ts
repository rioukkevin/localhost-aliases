/**
 * Onboarding state. Every step reports what is actually true on the machine, never an
 * optimistic guess: `apply` reads the live diff, `verify` really fetches the dashboard
 * through its alias, and `mcp` reads the client config files.
 *
 * Only the pure user decisions (reading the explanation, skipping an optional step) are
 * remembered in a file, because nothing on the machine records them.
 */
import { join } from "node:path";
import {
  RESERVED_ALIAS_NAME,
  caCertPath,
  codexSnippet,
  configDir,
  hostnameFor,
  loadConfig,
  type OnboardingStep,
  type OnboardingStepId,
} from "@localhost-aliases/core";
import { readJsonOrNull, readTextOrNull, writeJsonAtomic } from "./files.ts";
import { NotFoundError, invalid } from "./http.ts";
import { getMcpState, installMcpClient, sync, type ServiceOptions, type SyncReport } from "./service.ts";

const VERIFY_TIMEOUT_MS = 4_000;

export const STEP_IDS: readonly OnboardingStepId[] = ["explain", "apply", "verify", "https", "mcp"];
/** Everything else is optional; onboarding is "complete" without them. */
const REQUIRED_STEPS: readonly OnboardingStepId[] = ["explain", "apply", "verify"];

interface StoredStep {
  state: OnboardingStep["state"];
  detail?: string;
  at: string;
  /** Recorded with `verify` so a later TLD change invalidates the result. */
  hostname?: string;
}

interface OnboardingRecord {
  steps?: Partial<Record<OnboardingStepId, StoredStep>>;
  /** The user dismissed the whole flow. */
  skipped?: boolean;
}

function onboardingPath(): string {
  return join(configDir(), "onboarding.json");
}

async function readRecord(): Promise<OnboardingRecord> {
  return (await readJsonOrNull<OnboardingRecord>(onboardingPath())) ?? {};
}

async function patchRecord(patch: (record: OnboardingRecord) => OnboardingRecord): Promise<void> {
  await writeJsonAtomic(onboardingPath(), patch(await readRecord()));
}

async function recordStep(id: OnboardingStepId, stored: StoredStep): Promise<void> {
  await patchRecord((record) => ({ ...record, steps: { ...record.steps, [id]: stored } }));
}

function step(
  id: OnboardingStepId,
  title: string,
  state: OnboardingStep["state"],
  detail: string | null,
  needsUser: boolean,
): OnboardingStep {
  return { id, title, state, detail, needsUser };
}

/** Exactly what the privileged batch touches, in plain words, before it runs. */
function changeList(hosts: Array<{ ip: string; hostname: string }>, ips: readonly string[]): string[] {
  return [
    `Add ${hosts.length} ${hosts.length === 1 ? "entry" : "entries"} to a marked block in /etc/hosts: ${hosts
      .map((h) => `${h.ip} ${h.hostname}`)
      .join(", ")}.`,
    `Add ${ips.length} loopback ${ips.length === 1 ? "address" : "addresses"} to lo0: ${ips.join(", ")}.`,
    "Flush the DNS cache.",
    "Start a root TCP forwarder that exits on its own when the app stops.",
    "Nothing is installed permanently: no LaunchDaemon, no background installer.",
  ];
}

/**
 * Why the names look the way they do. Said up front because the suffix is the one choice a
 * developer is most likely to want to "fix" to `.local` out of habit — and `.local` is the
 * one suffix macOS makes unusable.
 */
function namingNote(tld: string): string {
  return (
    `Every alias ends in .${tld}, the default, because RFC 6761 reserves .${tld} for local ` +
    `development: it never resolves on the public internet and it is answered straight from ` +
    `/etc/hosts. .local is deliberately not offered — macOS hands it to Bonjour/mDNS, which ` +
    `waits about 5 seconds for a multicast answer on every single lookup, in or out of /etc/hosts.`
  );
}

async function caInstalled(): Promise<boolean> {
  return (await readTextOrNull(caCertPath())) !== null;
}

export interface McpClientInfo {
  id: string;
  name: string;
  configured: boolean;
  path: string;
  /** Present for clients we can only half-automate; the user pastes it. */
  snippet?: string;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  complete: boolean;
  skipped: boolean;
  changes: string[];
  /** One sentence on the alias suffix: what it is, and why .local is not an option. */
  naming: string;
  /** The command the admin prompt will run, shown verbatim before it runs. */
  command: string | null;
  verifyUrl: string;
  mcpClients: McpClientInfo[];
  sync: SyncReport;
}

export async function getOnboarding(options: ServiceOptions = {}): Promise<OnboardingState> {
  const record = await readRecord();
  const stored = record.steps ?? {};
  const { config, desired, report } = await sync(options);
  const hostname = hostnameFor(RESERVED_ALIAS_NAME, config.tld);
  const mcp = await getMcpState();
  const changes = changeList(desired.hosts, desired.loopbackIps);

  const explain = step(
    "explain",
    "What will change",
    stored.explain?.state ?? "pending",
    changes.join(" "),
    true,
  );

  const apply = step(
    "apply",
    "Apply to this Mac",
    report.applied ? "done" : "pending",
    report.applied
      ? "Hosts, loopback addresses and the forwarder all match the desired state."
      : report.drift.join(" ") || "Nothing to apply yet.",
    report.needsPrompt,
  );

  const verified = stored.verify;
  const verifyUsable = report.applied && verified !== undefined && verified.hostname === hostname;
  const verify = step(
    "verify",
    "Verify",
    verifyUsable ? verified.state : "pending",
    verifyUsable ? (verified.detail ?? null) : `Not checked yet. This really requests http://${hostname}.`,
    false,
  );

  const httpsDone = config.https && (await caInstalled());
  const https = step(
    "https",
    "HTTPS for the dashboard",
    httpsDone ? "done" : (stored.https?.state ?? "pending"),
    "Only the dashboard can be served over https. Project aliases forward raw TCP, so their bytes are " +
      "never decrypted here and can never be https. Firefox keeps its own trust store and needs the " +
      "certificate added separately.",
    !httpsDone,
  );

  const configured = mcp.clients.filter((c) => c.configured).map((c) => c.name);
  const mcpStep = step(
    "mcp",
    "MCP server",
    mcp.configured ? "done" : (stored.mcp?.state ?? "pending"),
    configured.length > 0
      ? `Registered in ${configured.join(" and ")}.`
      : "Lets Claude Code and Codex create and inspect aliases for you.",
    !mcp.configured,
  );

  const steps = [explain, apply, verify, https, mcpStep];
  const byId = new Map(steps.map((s) => [s.id, s]));

  return {
    steps,
    complete: REQUIRED_STEPS.every((id) => byId.get(id)?.state === "done"),
    skipped: record.skipped === true,
    changes,
    naming: namingNote(config.tld),
    command: report.intent.command.join(" "),
    verifyUrl: `http://${hostname}`,
    mcpClients: mcp.clients.map((client) => ({
      id: client.id,
      name: client.name,
      configured: client.configured,
      path: client.configPath,
      ...(client.id === "codex" ? { snippet: codexSnippet(mcp.spec) } : {}),
    })),
    sync: report,
  };
}

// --- advancing --------------------------------------------------------------

export type OnboardingAction = OnboardingStepId | "skip" | "restart";

export interface AdvanceResult extends OnboardingState {
  /** Set by `apply`: what the tray must run under the single admin prompt. */
  intent?: SyncReport["intent"];
  /** Set by `mcp` when a client config was written. */
  installed?: unknown;
}

function assertAction(value: unknown): OnboardingAction {
  if (typeof value === "string") {
    if (value === "skip" || value === "restart") return value;
    const id = STEP_IDS.find((s) => s === value);
    if (id) return id;
  }
  throw new NotFoundError(`Unknown onboarding step "${String(value)}".`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A real HTTP request through the alias. Any response at all proves forwarding works. */
async function runVerify(hostname: string): Promise<StoredStep> {
  const url = `http://${hostname}`;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    return { state: "done", detail: `${url} answered with HTTP ${response.status}.`, at: nowIso(), hostname };
  } catch (error) {
    return {
      state: "failed",
      detail: `${url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      at: nowIso(),
      hostname,
    };
  }
}

export async function advanceOnboarding(
  action: unknown,
  body: Record<string, unknown> = {},
  options: ServiceOptions = {},
): Promise<AdvanceResult> {
  const id = assertAction(action);
  const config = await loadConfig();
  const hostname = hostnameFor(RESERVED_ALIAS_NAME, config.tld);
  let installed: unknown;
  let intent: SyncReport["intent"] | undefined;

  switch (id) {
    case "restart": {
      await writeJsonAtomic(onboardingPath(), { steps: {}, skipped: false } satisfies OnboardingRecord);
      break;
    }
    case "skip": {
      await patchRecord((record) => ({ ...record, skipped: true }));
      break;
    }
    case "explain": {
      await recordStep("explain", { state: "done", at: nowIso() });
      break;
    }
    case "apply": {
      // The dashboard is unprivileged by design: it refreshes the files the privileged
      // script reads and hands back the intent. The tray raises the one prompt.
      intent = (await sync(options)).report.intent;
      break;
    }
    case "verify": {
      await recordStep("verify", await runVerify(hostname));
      break;
    }
    case "https": {
      if (body.skip === true) {
        await recordStep("https", { state: "skipped", at: nowIso() });
        break;
      }
      const state = body.state;
      if (state !== "done" && state !== "failed") {
        throw invalid(
          "state",
          'Certificates are generated by the app, not the dashboard. Send {"skip":true} to skip this step.',
        );
      }
      await recordStep("https", {
        state,
        at: nowIso(),
        ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
      });
      break;
    }
    case "mcp": {
      if (body.skip === true) {
        await recordStep("mcp", { state: "skipped", at: nowIso() });
        break;
      }
      installed = (await installMcpClient(body)).installed;
      break;
    }
  }

  const state = await getOnboarding(options);
  return { ...state, ...(intent ? { intent } : {}), ...(installed ? { installed } : {}) };
}
