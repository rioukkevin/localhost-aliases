"use client";

import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";
import { AliasRow } from "./AliasRow.tsx";

export interface AliasRowsProps {
  /** The rows to draw. */
  rows: readonly AliasView[];
  /** Every alias, so the inline editor can tell you a name is already taken. */
  aliases: readonly AliasView[];
  tld: string;
  editingId: string | null;
  /** The "Port" legend strip. Off inside the drawer, where the rack label says it. */
  legend?: boolean;
  hideProjectPath?: boolean;
  onEdit: (id: string | null) => void;
  onSave: (id: string, input: CreateAliasInput) => Promise<void>;
  onDelete: (alias: AliasView) => Promise<void>;
  onDetach: (alias: AliasView) => Promise<void>;
}

/**
 * A rack of patch cables. The `@container` here is what lets AliasRow lay itself out
 * against the width it actually got — the page column or a drawer — instead of the
 * window's.
 */
export function AliasRows({
  rows,
  aliases,
  tld,
  editingId,
  legend = false,
  hideProjectPath = false,
  onEdit,
  onSave,
  onDelete,
  onDetach,
}: AliasRowsProps) {
  return (
    <div className="@container">
      {legend ? (
        // The two spacers repeat the row widths so "Port" sits above the ports.
        <div className="hidden items-center gap-x-4 border-b border-hairline px-4 py-1.5 @xl:flex @2xl:px-8">
          <span className="w-3.5 shrink-0" />
          <span className="flex-1 text-[10px] font-medium uppercase tracking-[0.18em] text-faint @4xl:w-[22rem] @4xl:flex-none">
            Name
          </span>
          <span className="flex-1" />
          <span className="w-[4.5rem] text-right text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
            Port
          </span>
          <span className="w-[11rem] shrink-0" />
        </div>
      ) : null}

      <ul className="divide-y divide-hairline">
        {rows.map((alias) => (
          <AliasRow
            key={alias.id}
            alias={alias}
            aliases={aliases}
            tld={tld}
            editing={editingId === alias.id}
            hideProjectPath={hideProjectPath}
            onEdit={onEdit}
            onSave={onSave}
            onDelete={onDelete}
            onDetach={onDetach}
          />
        ))}
      </ul>
    </div>
  );
}

/** The two-row shimmer shown until the first poll answers. */
export function AliasRowsSkeleton() {
  return (
    <ul aria-busy="true" className="divide-y divide-hairline">
      {[0, 1].map((i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-4 md:px-8">
          <span className="h-3.5 w-3.5 rounded-full bg-sunken" />
          <span className="h-4 w-40 bg-sunken" />
          <span className="h-px flex-1 bg-hairline" />
          <span className="h-4 w-10 bg-sunken" />
        </li>
      ))}
    </ul>
  );
}
