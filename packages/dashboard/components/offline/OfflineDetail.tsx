"use client";

import type { OfflineView } from "../../lib/client/api.ts";
import { tildePath } from "../../lib/client/format.ts";
import { LinkButton } from "../LinkButton.tsx";
import { Chip } from "../ui/Chip.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Panel } from "../ui/Panel.tsx";
import { PatchCable } from "../ui/PatchCable.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";

export interface OfflineDetailProps {
  /** Null until the first read comes back. */
  view: OfflineView | null;
  /** The last read failed. The page keeps showing what it had. */
  error: string | null;
  /** The hostname from the query string, so the page can name it before the first read. */
  requested: string;
  /**
   * Is the root agent running? `null` until the shell's poll has answered. It matters
   * here because it decides which of two different problems the user has: with the agent
   * up, the name resolves and only the dev server is missing; with it down, the name does
   * not resolve at all and the dev server is the second thing to fix, not the first.
   */
  agentUp?: boolean | null;
}

/**
 * The whole /offline page below the header, as a pure function of one reading.
 *
 * The voice here matters more than anywhere else in the app: the user arrived because
 * something did not work, from a page the root agent served in place of their site. So
 * every claim is bounded — we say what is not accepting connections on which port, never
 * "your server has crashed"; and when we do not recognise the folder we say that in one
 * sentence instead of printing a command that would start nothing.
 */
export function OfflineDetail({ view, error, requested, agentUp = null }: OfflineDetailProps) {
  const hostname = view?.hostname || requested;

  if (view === null) {
    return (
      <Panel title="checking" data-testid="offline-loading">
        <p className="text-[13px] leading-relaxed text-muted">
          Reading this Mac for <span className="mono text-ink">{hostname || "the alias"}</span>…
        </p>
      </Panel>
    );
  }

  if (!view.known || !view.alias) {
    return (
      <Panel title="no such alias" data-testid="offline-unknown">
        <EmptyState
          title={hostname ? `Nothing is patched to ${hostname}` : "No alias was named"}
          actions={
            <LinkButton href="/" variant="primary" size="sm">
              Open the patchbay
            </LinkButton>
          }
        >
          {hostname
            ? `No alias on this Mac carries the name ${hostname}. It may have been renamed or unpatched since this page was opened — the patchbay lists everything that exists right now.`
            : "This page needs a hostname, e.g. /offline?host=myapp.test. The patchbay lists every alias on this Mac."}
        </EmptyState>
      </Panel>
    );
  }

  const alias = view.alias;
  const { stack } = view;
  const live = view.listening;

  return (
    <div className="flex flex-col gap-6" data-testid="offline-detail" data-listening={live}>
      {error ? (
        <p className="mono text-[11px] leading-snug text-danger" data-testid="offline-error">
          The last check failed: {error} — nothing on your Mac has changed.
        </p>
      ) : null}

      {/* 1. What is patched to what, and which half is silent. */}
      <Panel
        title="the patch"
        aside={
          <Chip tone={live ? "live" : "down"} dot data-testid="offline-lamp">
            {live ? "listening" : "nothing there"}
          </Chip>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot status={live ? "up" : "down"} />
          <span className="mono text-[17px] leading-tight text-ink">{alias.hostname}</span>
          <PatchCable status={live ? "up" : "down"} className="min-w-[4rem] flex-1" />
          <span className="mono text-[17px] text-ink">
            <span className="text-faint">:</span>
            {alias.targetPort}
          </span>
        </div>

        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
          <span className="mono text-ink">{alias.hostname}</span> resolves to{" "}
          <span className="mono text-ink">{alias.ip}</span>, and the root agent splices{" "}
          <span className="mono text-ink">
            {alias.ip}:80
          </span>{" "}
          to <span className="mono text-ink">127.0.0.1:{alias.targetPort}</span>.{" "}
          {live ? (
            <>
              Something is accepting connections there now. Reload{" "}
              <span className="mono text-ink">{alias.url}</span> and you have your app back.
            </>
          ) : (
            <>
              Nothing is accepting connections on{" "}
              <span className="mono text-ink">127.0.0.1:{alias.targetPort}</span>, so there is
              nothing to splice to.{" "}
              {agentUp === true
                ? "The alias itself is fine: the name resolves and the root agent is answering, which is how you got this page."
                : agentUp === false
                  ? "The root agent is not running either, so this name does not resolve on its own right now. That is the first thing to fix — the banner above starts it — and this dev server is the second."
                  : "Whether the name resolves is a separate question from whether your dev server is up; the lamp in the corner reports the root agent."}
            </>
          )}
        </p>

        {live ? (
          <div className="mt-4">
            <LinkButton href={alias.url} variant="primary" size="sm" prefetch={false}>
              Open {alias.hostname}
            </LinkButton>
          </div>
        ) : null}
      </Panel>

      {/* 2. The command — or an honest admission that we do not know it. */}
      <Panel title="start it" data-testid="offline-start">
        {alias.projectPath === null ? (
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
            This alias has no project folder, so there is nothing here to read. Start your dev
            server on port <span className="mono text-ink">{alias.targetPort}</span> however you
            normally do. Give the alias a folder in the patchbay and this page can be more
            specific next time.
          </p>
        ) : stack === null ? (
          <>
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
              We do not recognise{" "}
              <span className="mono break-all text-ink" title={alias.projectPath}>
                {tildePath(alias.projectPath)}
              </span>
              , so we will not guess a command — a command that starts the wrong thing, or
              starts it on the wrong port, is worse than none. Start it on port{" "}
              <span className="mono text-ink">{alias.targetPort}</span> the way you normally do.
            </p>
            <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-faint">
              Detection reads <span className="mono">package.json</span> scripts and
              dependencies, then <span className="mono">Gemfile</span>,{" "}
              <span className="mono">manage.py</span>, <span className="mono">artisan</span> and
              a plain <span className="mono">index.html</span>. It never runs anything and never
              writes into your repository.
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Chip tone="accent" data-testid="offline-framework">
                {stack.framework}
              </Chip>
              <span
                className="mono min-w-0 max-w-full truncate text-[11px] text-faint"
                title={alias.projectPath}
              >
                in {tildePath(alias.projectPath)}
              </span>
              {stack.confidence === "low" ? (
                <span className="text-[11px] text-faint">
                  inferred from the dependencies, not from a script — check it before you trust it
                </span>
              ) : null}
            </div>
            <CodeBlock
              className="mt-3"
              label={`starts this project on port ${alias.targetPort}`}
              value={stack.command}
              what="command"
              data-testid="offline-command"
            />
          </>
        )}
      </Panel>

      {/* 3. The failure everyone hits second: right port, wrong interface. Dropped the
             moment the port answers — it is the answer to a question the user no longer
             has, and leaving it up would read as "something is still wrong". */}
      {live ? null : (
      <Panel title="right port, still nothing" data-testid="offline-interface">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          The forwarder connects to <span className="mono text-ink">127.0.0.1</span> and to
          nothing else. A server that binds only <span className="mono text-ink">::1</span> (IPv6
          loopback), only your LAN address, or that lives in a container publishing to a
          different interface, is listening — just not anywhere we can reach. Same story for a
          dev server told to bind a hostname rather than an address.
        </p>
        <CodeBlock
          className="mt-3"
          label="see what is actually bound to that port"
          value={`lsof -nP -iTCP:${alias.targetPort} -sTCP:LISTEN`}
          what="command"
          data-testid="offline-lsof"
        />
        <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-muted">
          If the address column says <span className="mono text-ink">*:{alias.targetPort}</span>{" "}
          or <span className="mono text-ink">127.0.0.1:{alias.targetPort}</span>, we can reach it.
          If it says <span className="mono text-ink">[::1]:{alias.targetPort}</span> or a specific
          non-loopback address, tell your dev server to bind{" "}
          <span className="mono text-ink">127.0.0.1</span> or{" "}
          <span className="mono text-ink">0.0.0.0</span> instead — usually a{" "}
          <span className="mono text-ink">--host</span> flag or a{" "}
          <span className="mono text-ink">HOST</span> environment variable. If nothing is listed
          at all, the port is genuinely free and the server is not running.
        </p>
      </Panel>
      )}
    </div>
  );
}
