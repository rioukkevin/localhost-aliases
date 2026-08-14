"use client";

import { useState } from "react";
import { useStatus } from "../../lib/client/status-store.ts";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Panel } from "../ui/Panel.tsx";

/**
 * The way out. The list is disclosed in place rather than in a modal: a dialog on
 * top of a drawer would be two focus traps arguing over one Escape key, and the
 * content is a list to read, not a decision to confirm.
 */
export function UninstallSection() {
  const { aliases } = useStatus();
  const [showDetail, setShowDetail] = useState(false);

  return (
    <Panel title="uninstall" data-testid="uninstall-section">
      <Banner tone="danger" title="Remove everything this app changed">
        Stops the forwarder, removes the loopback addresses from lo0, strips the managed block
        from /etc/hosts, flushes DNS, deletes ~/.config/localhost-aliases and removes the local
        CA from your login keychain. One admin prompt, and nothing is left behind. Your projects
        and dev servers are not touched.
      </Banner>

      <p className="mt-4 text-[13px] leading-relaxed text-muted">
        All of that is privileged, so it does not run from this page — the dashboard is an
        unprivileged process and stays one. Use the menu-bar item, or run this in the repo:
      </p>
      <CodeBlock className="mt-3" value="make uninstall" what="command" label="uninstall" />

      <div className="mt-4">
        <Button
          variant="danger"
          size="sm"
          aria-expanded={showDetail}
          onClick={() => setShowDetail((was) => !was)}
          data-testid="uninstall"
        >
          {showDetail ? "Hide the details" : "What will be removed?"}
        </Button>
      </div>

      {showDetail ? (
        <div className="mt-3 border-t border-hairline pt-3 text-[12.5px] leading-relaxed text-muted">
          <ul className="space-y-1">
            <li>— the managed /etc/hosts block is removed; the rest of the file is untouched</li>
            <li>— every 127.0.0.x loopback alias this app added is removed from lo0</li>
            <li>— the root forwarder is stopped</li>
            <li>— ~/.config/localhost-aliases is deleted, including your {aliases.length} aliases</li>
            <li>— the local CA is removed from your login keychain</li>
          </ul>
          <p className="mt-3">
            It asks for your password once, and it cannot be undone. Run it from the menu-bar app
            or with <span className="mono text-ink">make uninstall</span>.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
