"use client";

import { useState } from "react";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";
import { isPending, tildePath } from "../../lib/client/format.ts";
import { IconButton } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { CopyButton } from "../ui/CopyButton.tsx";
import { IconExternal, IconPencil, IconTrash, IconUnlink } from "../ui/Icons.tsx";
import { PatchCable } from "../ui/PatchCable.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { AliasEditor } from "./AliasEditor.tsx";
import { applyChip, isLive, type AliasApply } from "./alias-apply.ts";

export interface AliasRowProps {
  alias: AliasView;
  aliases: readonly AliasView[];
  tld: string;
  editing: boolean;
  /**
   * Whether this name actually resolves on this Mac yet, and if not, why not. Passed in
   * rather than read here so the row stays a function of what it is given.
   */
  apply?: AliasApply;
  /** Hides the second line's folder path — the drawer already names the folder. */
  hideProjectPath?: boolean;
  onEdit: (id: string | null) => void;
  onSave: (id: string, input: CreateAliasInput) => Promise<void>;
  onDelete: (alias: AliasView) => Promise<void>;
  onDetach: (alias: AliasView) => Promise<void>;
}

const STATUS_NOTE: Record<AliasView["status"], string> = {
  up: "something is listening on this port",
  down: "nothing is listening on this port",
  unknown: "not checked yet",
};

/**
 * One patch cable: a name on the left, the port your dev server already uses on the right.
 *
 * The breakpoints are container queries, not viewport ones: the same row has to read
 * correctly full-width on the page and inside a narrow project drawer, and only the
 * container knows which it is. @xl ≈ the old `sm:`, @2xl ≈ `md:`, @4xl ≈ `lg:`.
 */
export function AliasRow({
  alias,
  aliases,
  tld,
  editing,
  apply = "unknown",
  hideProjectPath = false,
  onEdit,
  onSave,
  onDelete,
  onDetach,
}: AliasRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = isPending(alias);
  const chip = applyChip(apply);
  // The cable is the picture of the whole path working, so it may not drift until the
  // path exists. A dev server answering on :3000 does not make an unapplied name resolve.
  const live = isLive(apply);

  async function save(input: CreateAliasInput) {
    setBusy(true);
    try {
      await onSave(alias.id, input);
      onEdit(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      await onDelete(alias);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="bg-raised px-4 py-5 @2xl:px-8">
        <p className="mb-4 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          editing {alias.hostname}
        </p>
        <AliasEditor
          alias={alias}
          aliases={aliases}
          tld={tld}
          submitLabel="Save"
          busy={busy}
          onSubmit={save}
          onCancel={() => onEdit(null)}
        />
      </li>
    );
  }

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 transition-colors hover:bg-raised @2xl:px-8"
      data-testid="alias-row"
    >
      <span className="order-1 shrink-0" title={STATUS_NOTE[alias.status]}>
        <StatusDot status={alias.status} />
      </span>

      <div className="order-2 min-w-0 flex-1 @4xl:w-[22rem] @4xl:flex-none">
        <p className="mono flex items-center gap-2 text-[19px] font-medium leading-tight text-ink">
          <span className="truncate">
            {alias.name}
            <span className="text-faint">.{tld}</span>
          </span>
          {alias.reserved ? <Chip tone="accent">dashboard</Chip> : null}
          {chip ? (
            <span title={chip.title} data-testid="alias-apply" data-apply={apply}>
              <Chip tone={apply === "saving" ? "muted" : "down"} dot={apply !== "saving"}>
                {chip.label}
              </Chip>
            </span>
          ) : null}
        </p>
        <p className="mono mt-0.5 truncate text-[11px] text-faint">
          {alias.url}
          {alias.projectPath && !hideProjectPath ? ` · ${tildePath(alias.projectPath)}` : ""}
        </p>
      </div>

      <div className="order-4 basis-full pl-[1.9rem] @xl:order-3 @xl:basis-0 @xl:flex-1 @xl:pl-0">
        <PatchCable status={live ? alias.status : "unknown"} />
      </div>

      <p className="mono order-5 w-[4.5rem] text-right text-[17px] text-ink @xl:order-4">
        <span className="text-faint">:</span>
        {alias.port}
      </p>

      <div className="order-3 flex w-[11rem] shrink-0 items-center justify-end gap-0.5 @xl:order-5">
        <CopyButton value={alias.url} what="URL" />
        <a
          href={alias.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${alias.hostname}`}
          title={`Open ${alias.hostname}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[2px] border border-transparent text-muted transition-colors hover:border-hairline hover:text-ink"
        >
          <IconExternal />
        </a>
        {alias.projectPath && !alias.reserved ? (
          <IconButton
            label={`Detach ${alias.hostname} from its folder`}
            disabled={pending}
            onClick={() => void onDetach(alias)}
          >
            <IconUnlink />
          </IconButton>
        ) : null}
        {alias.reserved ? null : (
          <>
            <IconButton
              label={`Edit ${alias.hostname}`}
              disabled={pending}
              onClick={() => onEdit(alias.id)}
            >
              <IconPencil />
            </IconButton>
            <IconButton
              label={`Delete ${alias.hostname}`}
              tone="danger"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              <IconTrash />
            </IconButton>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={`Unpatch ${alias.hostname}?`}
        confirmLabel="Delete alias"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirmDelete()}
      >
        The name stops resolving and its loopback address is released. Your dev server on
        port {alias.port} is not touched. This needs one admin prompt, because /etc/hosts
        and the loopback addresses change.
      </ConfirmDialog>
    </li>
  );
}
