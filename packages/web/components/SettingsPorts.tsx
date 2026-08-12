"use client";

import { Chip } from "./Chip.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { Panel } from "./Panel.tsx";
import { TextField } from "./TextField.tsx";
import { Toggle } from "./Toggle.tsx";
import type { StatusWithCommands } from "../lib/client/useSettings.ts";

export interface SettingsPortsProps {
  httpPort: string;
  httpsPort: string;
  https: boolean;
  errors: { httpPort?: string; httpsPort?: string };
  status: StatusWithCommands | null;
  onChange: (patch: { httpPort?: string; httpsPort?: string; https?: boolean }) => void;
}

export function SettingsPorts({
  httpPort,
  httpsPort,
  https,
  errors,
  status,
  onChange,
}: SettingsPortsProps) {
  const helper = status?.helper;
  const ca = status?.ca;
  const trustCommand = status?.commands?.trust;

  return (
    <Panel
      title="Proxy ports"
      meta={
        helper?.running
          ? `helper listening on :${helper.status?.http.port ?? httpPort}`
          : "helper not running"
      }
    >
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-6">
        <TextField
          label="HTTP port"
          data-testid="settings-http-port-input"
          value={httpPort}
          onChange={(event) => onChange({ httpPort: event.target.value })}
          prefix=":"
          inputMode="numeric"
          autoComplete="off"
          error={errors.httpPort ?? null}
          hint="Plain HTTP listener."
          className="md:w-[11rem] md:shrink-0"
        />
        <TextField
          label="HTTPS port"
          data-testid="settings-https-port-input"
          value={httpsPort}
          onChange={(event) => onChange({ httpsPort: event.target.value })}
          prefix=":"
          inputMode="numeric"
          autoComplete="off"
          error={errors.httpsPort ?? null}
          hint={https ? "TLS listener." : "Unused while HTTPS is off."}
          className="md:w-[11rem] md:shrink-0"
        />
        <p className="max-w-md flex-1 text-[12px] leading-relaxed text-muted md:pt-[1.9rem]">
          Only the root helper can bind ports below 1024. Keeping{" "}
          <span className="mono text-ink">:80</span> is what lets an alias be typed as{" "}
          <span className="mono text-ink">http://myapp.test</span> with no port at all.
        </p>
      </div>

      <div className="mt-6 border-t border-hairline pt-5">
        <Toggle
          checked={https}
          onChange={(next) => onChange({ https: next })}
          label="Serve aliases over HTTPS"
          hint="Issues one certificate from a local CA covering every hostname."
          data-testid="settings-https-toggle"
        />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Chip tone={ca?.generated ? "live" : "muted"} dot={Boolean(ca?.generated)}>
            {ca?.generated ? "local CA created" : "no local CA yet"}
          </Chip>
          <Chip tone={ca?.trusted ? "live" : "down"} dot>
            {ca?.trusted ? "trusted by this Mac" : "not trusted yet"}
          </Chip>
          {ca?.path ? (
            <span className="mono truncate text-[11px] text-faint" title={ca.path}>
              {ca.path}
            </span>
          ) : null}
        </div>

        <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-muted">
          {ca?.trusted
            ? "The certificate authority is already trusted in the System keychain, so HTTPS aliases open without a warning. Re-run the command below if you ever regenerate the CA."
            : "Until this certificate authority is trusted, every HTTPS alias shows a browser warning. The command adds it to the System keychain and asks for your password. Nothing outside this Mac is involved."}
        </p>

        {trustCommand ? (
          <CodeBlock
            value={trustCommand}
            what="trust command"
            className="mt-3 max-w-2xl"
            data-testid="settings-trust-command"
          />
        ) : (
          <p className="mt-3 text-[12px] text-faint">
            The trust command appears once the dashboard can read the CA path.
          </p>
        )}
      </div>
    </Panel>
  );
}
