"use client";

import { useStatus } from "../../lib/client/status-store.ts";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Panel } from "../ui/Panel.tsx";

/**
 * What the padlock actually depends on.
 *
 * Turning https on issues the certificate by itself — that part really is automatic. The one
 * step that cannot be is trusting the root, because macOS asks for the keychain password and
 * an app that installs a trusted root without asking is indistinguishable from malware. So
 * this says exactly where things stand and hands over the command, rather than claiming a
 * padlock the browser is not going to draw.
 */
export function TlsSection() {
  const { tls, loaded } = useStatus();

  if (!loaded || !tls) {
    return (
      <Panel title="https">
        <p className="text-[12.5px] text-muted">checking…</p>
      </Panel>
    );
  }

  if (!tls.enabled) {
    return (
      <Panel title="https">
        <p className="text-[12.5px] leading-relaxed text-muted">
          Off. Aliases answer on <span className="mono text-ink">http://</span> only.
          {tls.trusted ? " The certificate authority is already trusted, so turning this on needs nothing further." : ""}
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="https">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip tone={tls.certReady ? "live" : "muted"}>
          {tls.certReady ? "certificate issued" : "no certificate"}
        </Chip>
        <Chip tone={tls.trusted ? "live" : "down"}>
          {tls.trusted ? "trusted by this Mac" : "not trusted yet"}
        </Chip>
        {tls.expiresInDays !== null ? (
          <span className="text-[11px] text-faint">renews automatically · {tls.expiresInDays} days left</span>
        ) : null}
      </div>

      {tls.error ? (
        <p className="mb-3 text-[12.5px] leading-relaxed text-down" data-testid="tls-error">
          The certificate could not be prepared: {tls.error}. Your aliases still work over
          http; only the padlock is missing.
        </p>
      ) : null}

      {tls.trusted ? (
        <p className="text-[12.5px] leading-relaxed text-muted">
          Browsers show a padlock for every alias. Firefox keeps its own list of trusted
          authorities and will still warn until you add this one there too.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[12.5px] leading-relaxed text-muted">
            The certificate exists, but your Mac has not been told to trust the authority that
            signed it — so the browser still shows a warning. Run this once. macOS will ask for
            your password; nothing here runs as root, and the authority lives in your own login
            keychain.
          </p>
          <CodeBlock
            label="trust the certificate authority"
            value={tls.trustCommand}
            what="command"
            data-testid="tls-trust-command"
          />
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Undo it any time in Keychain Access, or with Settings → Uninstall, which removes it
            by fingerprint.
          </p>
        </>
      )}
    </Panel>
  );
}
