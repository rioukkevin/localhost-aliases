"use client";

import type { AliasView } from "@localhost-aliases/core";
import { AliasDetachButton } from "./AliasDetachButton.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { IconExternal } from "./Icons.tsx";
import { PatchCable } from "./PatchCable.tsx";
import { StatusDot } from "./StatusDot.tsx";

const STATUS_NOTE: Record<AliasView["status"], string> = {
  up: "upstream is answering",
  down: "nothing is listening on this port",
  unknown: "not probed yet",
};

export interface AliasMiniProps {
  alias: AliasView;
  /** When given, the row offers "detach from this project". */
  onDetach?: (id: string) => Promise<boolean>;
}

/**
 * Read-only patch row. The Aliases view owns editing; every other view shows the
 * same cable at a smaller weight so the patchbay reads as one language.
 */
export function AliasMini({ alias, onDetach }: AliasMiniProps) {
  const suffix = alias.hostname.startsWith(`${alias.name}.`)
    ? alias.hostname.slice(alias.name.length)
    : "";

  return (
    <li
      data-testid="project-alias"
      data-alias={alias.hostname}
      data-status={alias.status}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-raised md:px-6"
    >
      <span title={STATUS_NOTE[alias.status]} className="order-1 shrink-0">
        <StatusDot status={alias.status} />
      </span>

      <p
        title={alias.hostname}
        className="mono order-2 min-w-0 flex-1 truncate text-[15px] leading-tight text-ink sm:w-[16rem] sm:flex-none"
      >
        {alias.name}
        <span className="text-faint">{suffix}</span>
      </p>

      <div className="order-4 min-w-[2rem] flex-1 basis-full pl-[1.9rem] sm:order-3 sm:basis-0 sm:pl-0">
        <PatchCable status={alias.status} />
      </div>

      <p className="mono order-5 w-[4.5rem] shrink-0 text-right text-[15px] leading-tight text-ink sm:order-4">
        <span className="text-faint">:</span>
        {alias.port}
      </p>

      <div
        className={`order-3 ml-auto flex shrink-0 items-center justify-end gap-0.5 sm:order-5 sm:ml-0 ${
          onDetach ? "w-[6.5rem]" : "w-[4.25rem]"
        }`}
      >
        <CopyButton value={alias.url} what={`URL for ${alias.hostname}`} />
        <a
          href={alias.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${alias.url} in a new tab`}
          title="Open in browser"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[2px] border border-transparent text-muted transition-colors hover:border-hairline hover:text-ink"
        >
          <IconExternal />
        </a>
        {onDetach ? <AliasDetachButton alias={alias} onDetach={onDetach} /> : null}
      </div>
    </li>
  );
}
