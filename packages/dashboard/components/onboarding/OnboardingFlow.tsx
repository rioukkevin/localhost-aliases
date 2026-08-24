"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_TLD } from "@localhost-aliases/core/types";
import type { OnboardingStep, OnboardingStepId } from "@localhost-aliases/core/types";
import * as api from "../../lib/client/api.ts";
import { refreshStatus, useStatus } from "../../lib/client/status-store.ts";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Panel } from "../ui/Panel.tsx";
import { LinkButton } from "../LinkButton.tsx";
import { useToast } from "../ui/Toast.tsx";
import { ApplyStep } from "./ApplyStep.tsx";
import { ExitSetup } from "./ExitSetup.tsx";
import { UNKNOWN_PLAN, exitPlan, needsSkipRecorded } from "./exit-state.ts";
import { StepShell } from "./StepShell.tsx";

const ORDER: OnboardingStepId[] = ["explain", "apply", "verify", "https", "mcp"];

/** Said in the UI before anything happens, and true of the shipped apply script. */
const CHANGES = [
  "adds a managed block to /etc/hosts, between two marker comments — every line outside the markers is left byte-for-byte",
  "adds loopback addresses (127.0.0.2 and up) to lo0, one per alias",
  "flushes the DNS cache so the new names resolve immediately",
  "starts a small root process that forwards <loopback-ip>:80 to 127.0.0.1:<your port>",
];

/** Server copy wins; this is what the panel says before the first fetch lands. */
const NAMING =
  `Every alias ends in .${DEFAULT_TLD}, the default, because RFC 6761 reserves .${DEFAULT_TLD} for local ` +
  "development: it never resolves on the public internet and it is answered straight from " +
  "/etc/hosts. .local is deliberately not offered — macOS hands it to Bonjour/mDNS, which " +
  "waits about 5 seconds for a multicast answer on every single lookup, in or out of /etc/hosts.";

const NOT_CHANGED = [
  "nothing is installed in /Library, there is no LaunchDaemon and no background installer",
  "the root forwarder watches a heartbeat file and exits by itself when the app quits",
  "your dev servers are untouched — they keep listening on 127.0.0.1 exactly as before",
  "Settings → Uninstall reverses all of it behind one prompt",
];

function byId(steps: OnboardingStep[], id: OnboardingStepId): OnboardingStep {
  return (
    steps.find((s) => s.id === id) ?? {
      id,
      // Empty on purpose: the component falls back to its own wording until the
      // server's real step titles arrive.
      title: "",
      state: "pending" as const,
      detail: null,
      needsUser: true,
    }
  );
}

export function OnboardingFlow() {
  const { config } = useStatus();
  const router = useRouter();
  const toast = useToast();
  const [payload, setPayload] = useState<api.OnboardingPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<api.OnboardingAction | null>(null);
  const [leaving, setLeaving] = useState(false);
  const autoVerified = useRef(false);

  const load = useCallback(async () => {
    try {
      setPayload(await api.fetchOnboarding());
      setLoadError(null);
    } catch (err) {
      setLoadError(api.errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: api.OnboardingAction, options: Record<string, unknown> = {}) => {
      setRunning(action);
      try {
        setPayload(await api.runOnboarding(action, options));
        setLoadError(null);
      } catch (err) {
        toast.push({ tone: "error", title: "Step failed", detail: api.errorMessage(err) });
        await load();
      } finally {
        setRunning(null);
        await refreshStatus();
      }
    },
    [load, toast],
  );

  // The tray reported the privileged run finished: re-read the machine rather than
  // assuming anything, so the step turns green only if it really is applied.
  const applied = useCallback(async () => {
    await load();
    await refreshStatus();
  }, [load]);

  const steps = payload?.steps ?? [];
  const explain = byId(steps, "explain");
  const apply = byId(steps, "apply");
  const verify = byId(steps, "verify");
  const https = byId(steps, "https");
  const mcp = byId(steps, "mcp");

  // Automate everything that can be automated: once the machine is applied, verifying
  // is a plain fetch, so it runs itself rather than waiting for a click.
  useEffect(() => {
    if (autoVerified.current) return;
    if (apply.state !== "done" || verify.state !== "pending" || running !== null) return;
    autoVerified.current = true;
    void run("verify");
  }, [apply.state, verify.state, running, run]);

  const doneCount = ORDER.filter((id) => {
    const s = byId(steps, id).state;
    return s === "done" || s === "skipped";
  }).length;

  const verifyUrl = payload?.verifyUrl ?? `http://index.${DEFAULT_TLD}`;
  // Server truth wins for `complete`. Before the first fetch lands there is no truth to
  // report, so the copy says so instead of accusing a working Mac of never being applied.
  const plan = payload ? exitPlan(steps, verifyUrl, payload.complete) : UNKNOWN_PLAN;

  // useSetupGate sends anyone back to /onboarding unless the record says complete or
  // skipped. So leaving early records the skip through the action the flow already has;
  // there is no second flag. Finished setups need nothing recorded — they just leave.
  const leave = useCallback(async () => {
    setLeaving(true);
    try {
      // The record decides, never the render: `payload` is null until the first read
      // lands, and guessing either way is a bug — guess "finished" and the gate bounces
      // the user back, guess "unfinished" and a finished setup gets a skip it never
      // asked for.
      const state = payload ?? (await api.fetchOnboarding());
      if (needsSkipRecorded(state)) await api.runOnboarding("skip");
      router.replace("/");
    } catch (err) {
      setLeaving(false);
      toast.push({
        tone: "error",
        title: "Could not leave setup",
        detail: api.errorMessage(err),
      });
    }
  }, [payload, router, toast]);

  const command =
    payload?.command ??
    "osascript -e 'do shell script \"…/privileged/apply.sh …/desired-state.json\" with administrator privileges'";

  return (
    <div className="flex flex-col gap-6">
      {loadError ? (
        <Banner
          tone="danger"
          title="Cannot read the setup state"
          actions={
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          The steps below still describe exactly what setup does, but their state is the last
          one read. {loadError}
        </Banner>
      ) : null}

      {payload?.complete ? (
        <Banner tone="info" title="Setup is complete">
          Every required step is done. You can re-run any step below at any time — it is
          idempotent, so running it twice changes nothing.
        </Banner>
      ) : null}

      <Panel
        title="setup"
        meta={`${doneCount} of ${ORDER.length} steps`}
        padded={false}
        aside={
          <div className="flex items-center gap-1" aria-hidden="true">
            {ORDER.map((id) => {
              const state = byId(steps, id).state;
              return (
                <span
                  key={id}
                  className={[
                    "block h-[3px] w-8",
                    state === "done"
                      ? "bg-accent"
                      : state === "failed"
                        ? "bg-danger"
                        : state === "skipped"
                          ? "bg-faint"
                          : "bg-hairline-strong",
                  ].join(" ")}
                />
              );
            })}
          </div>
        }
        footer={
          <ExitSetup
            plan={plan}
            busy={leaving}
            onExit={() => void leave()}
            secondary={
              <Button
                variant="ghost"
                busy={running === "restart"}
                disabled={running !== null || leaving}
                onClick={() => void run("restart")}
              >
                Start over
              </Button>
            }
          />
        }
      >
        <ol>
          <StepShell
            index={1}
            step={{ ...explain, title: explain.title || "What will change on this Mac" }}
            actions={
              <Button
                variant={explain.state === "done" ? "outline" : "primary"}
                busy={running === "explain"}
                onClick={() => void run("explain")}
              >
                {explain.state === "done" ? "Read it again" : "I understand — continue"}
              </Button>
            }
          >
            <p className="text-faint">{payload?.naming ?? NAMING}</p>
            <p className="mt-3">Applying does exactly four things, and nothing else:</p>
            <ul className="mt-2 space-y-1">
              {(payload?.changes.length ? payload.changes : CHANGES).map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden="true" className="text-faint">
                    —
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3">Just as important, what it does not do:</p>
            <ul className="mt-2 space-y-1">
              {NOT_CHANGED.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden="true" className="text-faint">
                    —
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3">
              One limit, stated plainly: the forwarder moves raw bytes and never reads them, so
              WebSockets and any other protocol pass straight through — and there is nothing in
              the traffic path that could terminate TLS. Project aliases are{" "}
              <span className="mono text-ink">http://</span> only. Only the dashboard itself can
              be served over https, because the dashboard is our own server.
            </p>
          </StepShell>

          <ApplyStep
            index={2}
            step={{ ...apply, title: apply.title || "Apply to this Mac (one admin prompt)" }}
            command={command}
            reasons={payload?.sync.privileged ?? []}
            needsPrompt={payload?.sync.needsPrompt ?? false}
            disabled={explain.state !== "done" && apply.state !== "done"}
            onApplied={applied}
          />

          <StepShell
            index={3}
            step={{ ...verify, title: verify.title || "Verify it actually works" }}
            actions={
              <Button
                busy={running === "verify"}
                onClick={() => void run("verify")}
                data-testid="verify-now"
              >
                {verify.state === "done" ? "Check again" : "Check now"}
              </Button>
            }
          >
            <p>
              No optimism here: the server really fetches{" "}
              <span className="mono text-ink">{verifyUrl}</span> and reports what came back —
              the status line, or the exact error if the name does not resolve yet.
            </p>
          </StepShell>

          <StepShell
            index={4}
            step={{ ...https, title: https.title || "HTTPS for the dashboard" }}
            optional
            actions={
              <>
                <LinkButton href="/#settings" variant="outline">
                  Turn it on in Settings
                </LinkButton>
                <Button
                  variant="ghost"
                  busy={running === "https"}
                  onClick={() => void run("https", { skip: true })}
                  data-testid="https-skip"
                >
                  Skip this step
                </Button>
              </>
            }
          >
            <p>
              The certificate is generated and trusted by the menu-bar app, not by this page:
              trusting a CA is a keychain operation and the dashboard has no business doing it.
              It goes into your <em>login</em> keychain (never the System keychain) and serves
              the dashboard over{" "}
              <span className="mono text-ink">https://index.{config?.tld ?? DEFAULT_TLD}</span>.
              Firefox keeps its own certificate store and will still warn until you trust the CA
              there too. Your project aliases stay http:// either way.
            </p>
          </StepShell>

          <StepShell
            index={5}
            step={{ ...mcp, title: mcp.title || "MCP server for your coding agents" }}
            optional
            actions={
              <>
                {(payload?.mcpClients.length
                  ? payload.mcpClients
                  : [
                      { id: "claude", name: "Claude Code", configured: false },
                      { id: "codex", name: "Codex", configured: false },
                    ]
                ).map((client) => (
                  <Button
                    key={client.id}
                    busy={running === "mcp"}
                    onClick={() => void run("mcp", { client: client.id })}
                  >
                    {client.configured ? `Reinstall for ${client.name}` : `Install for ${client.name}`}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  disabled={running !== null}
                  onClick={() => void run("mcp", { skip: true })}
                >
                  Skip this step
                </Button>
              </>
            }
          >
            <p>
              Adds a stdio MCP server so Claude Code and Codex can list and create aliases for
              you. It writes one entry into each client&apos;s config file and nothing else.
            </p>
            {payload && payload.mcpClients.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {payload.mcpClients.map((client) => (
                  <li key={client.id} className="flex flex-wrap items-center gap-2">
                    <Chip tone={client.configured ? "live" : "muted"} dot>
                      {client.configured ? "configured" : "not configured"}
                    </Chip>
                    <span className="text-[12.5px] text-ink">{client.name}</span>
                    {client.path ? (
                      <span className="mono text-[11px] text-faint">{client.path}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {payload?.mcpClients.find((c) => c.snippet) ? (
              <CodeBlock
                className="mt-3"
                label="paste this yourself if the file cannot be written"
                value={payload.mcpClients.find((c) => c.snippet)!.snippet!}
                what="snippet"
              />
            ) : null}
          </StepShell>
        </ol>
      </Panel>
    </div>
  );
}
