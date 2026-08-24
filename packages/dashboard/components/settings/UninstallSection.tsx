"use client";

import { useState } from "react";
import * as api from "../../lib/client/api.ts";
import { useStatus } from "../../lib/client/status-store.ts";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Panel } from "../ui/Panel.tsx";

/**
 * The way out — and now it really is one.
 *
 * It used to be a wall of text ending in "run `make uninstall`", which meant an installed app
 * could not be removed without a checkout of its own source. The whole teardown ships inside
 * the bundle now (Contents/Resources/privileged/teardown.sh), so this button starts the real
 * thing.
 *
 * What it does NOT do is run it. This process is unprivileged by design and stays that way: a
 * web page cannot raise a macOS admin prompt, and the app must be the thing that removes the
 * app. So the click asks the menu-bar app, over the same request channel every other
 * privileged action uses, and the menu-bar app owns the confirmation, the password prompt and
 * the report. One confirmation, in the process that does the work — not two, in two processes,
 * saying slightly different things.
 *
 * The list is disclosed in place and up front, not behind a toggle: it is what will be
 * removed, and it has to be readable before the button is pressed, not after.
 */

/** Exactly the steps teardown.sh performs, in order. */
export const REMOVED = [
  "the managed block in /etc/hosts — every line outside it is kept, byte for byte",
  "the 127.0.0.x loopback addresses this app added to lo0",
  "the root agent, stopped, and the DNS cache, flushed",
  "the local CA in your login keychain, matched by fingerprint — never by name",
  "~/.config/localhost-aliases, including your aliases",
  "the app itself, once it has quit",
] as const;

type Handover = { tone: "info" | "danger"; title: string; detail: string };

export function UninstallSection() {
  const { aliases, trayAlive } = useStatus();
  const [busy, setBusy] = useState(false);
  const [handover, setHandover] = useState<Handover | null>(null);

  const start = () => {
    setBusy(true);
    setHandover(null);
    void api
      .requestPrivileged("uninstall")
      .then((asked) => {
        if (asked.request) {
          setHandover({
            tone: "info",
            title: "Over to the menu-bar app",
            detail:
              "It is asking you to confirm, then for your password once. This page goes away with the app.",
          });
        } else {
          setHandover({
            tone: "danger",
            title: "Nothing can raise the prompt",
            detail:
              asked.error ??
              "The menu-bar app is not running, so nothing picked this up. Start it, or run the command below.",
          });
        }
      })
      .catch((err: unknown) =>
        setHandover({ tone: "danger", title: "Could not ask", detail: api.errorMessage(err) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Panel title="uninstall" data-testid="uninstall-section">
      <Banner tone="danger" title="Remove everything this app changed">
        One admin prompt, and nothing is left behind. Your projects and dev servers are not
        touched, and every line of /etc/hosts outside the managed block is kept exactly as it is.
      </Banner>

      <ul className="mt-4 space-y-1 text-[12.5px] leading-relaxed text-muted" data-testid="uninstall-plan">
        {REMOVED.map((line) => (
          <li key={line}>— {line}</li>
        ))}
      </ul>

      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        Every step reports what it did. A step that fails is named and the rest still run, so an
        uninstall never stops half-way through. It cannot be undone.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          busy={busy}
          disabled={busy || trayAlive === false}
          onClick={start}
          data-testid="uninstall"
        >
          Uninstall…
        </Button>
        {trayAlive === false ? (
          <span className="text-[12px] text-muted">
            The menu-bar app is not running — start it, or use the command below.
          </span>
        ) : null}
      </div>

      {handover ? (
        <div className="mt-4">
          <Banner tone={handover.tone} title={handover.title} data-testid="uninstall-handover">
            {handover.detail}
          </Banner>
        </div>
      ) : null}

      <p className="mt-4 text-[13px] leading-relaxed text-muted">
        In a checkout, the same teardown runs from the command line — it is the identical script,
        not a second implementation:
      </p>
      <CodeBlock className="mt-3" value="make uninstall" what="command" label="uninstall" />
      <p className="mt-2 text-[12px] leading-relaxed text-faint">
        {aliases.length === 1
          ? "1 alias will be deleted."
          : `${aliases.length} aliases will be deleted.`}
      </p>
    </Panel>
  );
}
