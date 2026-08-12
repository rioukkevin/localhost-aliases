"use client";

import type { AliasView } from "@localhost-aliases/core";
import { Panel } from "./Panel.tsx";
import { TextField } from "./TextField.tsx";
import { normalizeTld } from "../lib/client/settings-changes.ts";

/** Suggestions, best first. `.test` is the one reserved for exactly this use. */
const SUGGESTIONS = [
  { tld: "test", note: "reserved by RFC 2606", risky: false },
  { tld: "localhost", note: "always loopback", risky: false },
  { tld: "local", note: "claimed by Bonjour", risky: true },
] as const;

export interface SettingsHostnameProps {
  value: string;
  savedTld: string;
  error?: string;
  aliases: AliasView[];
  onChange: (next: string) => void;
}

export function SettingsHostname({
  value,
  savedTld,
  error,
  aliases,
  onChange,
}: SettingsHostnameProps) {
  const next = normalizeTld(value);
  const sample = aliases[0]?.name ?? "myapp";

  return (
    <Panel title="Hostnames" meta={`.${savedTld} in use`}>
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-6">
        <TextField
          label="TLD"
          data-testid="settings-tld-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          prefix="."
          placeholder="test"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          error={error ?? null}
          hint="Appended to every alias name."
          className="md:w-[15rem] md:shrink-0"
        />

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Suggestions
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((suggestion) => {
              const active = next === suggestion.tld;
              return (
                <button
                  key={suggestion.tld}
                  type="button"
                  onClick={() => onChange(suggestion.tld)}
                  data-testid={`settings-tld-${suggestion.tld}`}
                  className={[
                    "mono rounded-[2px] border px-2.5 py-1.5 text-[12px] transition-colors",
                    // The accent means "selected AND a good choice". A risky TLD
                    // selected is amber, so the highlight never contradicts the
                    // warning printed right underneath it.
                    active
                      ? suggestion.risky
                        ? "border-down text-ink"
                        : "border-accent bg-accent-dim text-ink"
                      : "border-hairline-strong text-muted hover:text-ink",
                  ].join(" ")}
                >
                  .{suggestion.tld}
                  <span className="ml-2 text-[10px] uppercase tracking-[0.12em] text-faint">
                    {suggestion.note}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Only a real rename is worth an arrow; `x.local → x.local` is noise. */}
          <p className="mono mt-3.5 truncate text-[12px] text-faint">
            {next === savedTld || next === "" ? (
              <span>
                {sample}.{savedTld}
                <span className="pl-2">— unchanged</span>
              </span>
            ) : (
              <>
                <span className="line-through decoration-faint">
                  {sample}.{savedTld}
                </span>
                <span className="px-2">→</span>
                <span className="text-ink">
                  {sample}.{next}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-6 border-l-2 border-down pl-3.5">
        <p className="text-[12.5px] font-medium text-ink">
          <span className="mono">.local</span> is formally reserved for mDNS / Bonjour
        </p>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">
          RFC 6762 assigns <span className="mono text-ink">.local</span> to multicast DNS. It
          usually still works here, because macOS consults{" "}
          <span className="mono text-ink">/etc/hosts</span> first — but it shares a namespace with
          every Bonjour device on your network, which can mean collisions and slow lookups.{" "}
          <span className="mono text-ink">.test</span> is reserved by RFC 2606 for exactly this
          purpose and can never become a real TLD, so it is the safe choice.
        </p>
        <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-muted">
          Changing this renames <span className="text-ink">every</span> alias at once: the managed{" "}
          <span className="mono text-ink">/etc/hosts</span> block is rewritten and the old names
          stop resolving. The exact list is shown before anything is applied.
        </p>
      </div>
    </Panel>
  );
}
