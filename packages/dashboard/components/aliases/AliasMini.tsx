"use client";

import type { AliasView } from "@localhost-aliases/core/types";
import { IconButton } from "../ui/Button.tsx";
import { CopyButton } from "../ui/CopyButton.tsx";
import { IconUnlink } from "../ui/Icons.tsx";
import { PatchCable } from "../ui/PatchCable.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";

export interface AliasMiniProps {
  alias: AliasView;
  onDetach?: (alias: AliasView) => void;
}

/** The read-only row: same composition as AliasRow, one step quieter. */
export function AliasMini({ alias, onDetach }: AliasMiniProps) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <StatusDot status={alias.status} className="shrink-0" />
      <p className="mono min-w-0 flex-1 truncate text-[15px] text-ink sm:flex-none sm:w-[16rem]">
        {alias.hostname}
      </p>
      <div className="hidden flex-1 sm:block">
        <PatchCable status={alias.status} />
      </div>
      <p className="mono w-[4.5rem] text-right text-[15px] text-ink">
        <span className="text-faint">:</span>
        {alias.port}
      </p>
      <div
        className={`flex ${onDetach ? "w-[6.5rem]" : "w-[4.25rem]"} shrink-0 justify-end gap-0.5`}
      >
        <CopyButton value={alias.url} what="URL" />
        {onDetach ? (
          <IconButton
            label={`Detach ${alias.hostname} from this folder`}
            onClick={() => onDetach(alias)}
          >
            <IconUnlink />
          </IconButton>
        ) : null}
      </div>
    </li>
  );
}
