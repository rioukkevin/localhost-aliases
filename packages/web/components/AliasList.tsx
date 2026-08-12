"use client";

import type { AliasView, UpdateAliasInput } from "@localhost-aliases/core";
import { AliasRow } from "./AliasRow.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { IconFolder } from "./Icons.tsx";
import { PatchCable } from "./PatchCable.tsx";
import { Spinner } from "./Button.tsx";
import { abbreviateHome } from "../lib/client/paths.ts";
import { projectGroups, type AliasGroup } from "../lib/client/grouping.ts";

export interface AliasListProps {
  groups: AliasGroup[];
  aliases: AliasView[];
  tld: string;
  /** $HOME, from the server component, so folders can read as ~/… */
  home: string;
  loading: boolean;
  applying: boolean;
  onUpdate: (id: string, patch: UpdateAliasInput) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onSetProject: (id: string, projectPath: string | null) => Promise<boolean>;
}

/**
 * The full patchbay, in rack order: one strip per project folder, then the
 * folderless aliases under "Unassigned". Grouping is the whole point of this
 * view now that projects are the primary one — but an alias never needs a
 * folder to exist here, which is what keeps quick one-offs cheap.
 */
export function AliasList({
  groups,
  aliases,
  tld,
  home,
  loading,
  applying,
  onUpdate,
  onDelete,
  onSetProject,
}: AliasListProps) {
  const live = aliases.filter((a) => a.status === "up").length;
  const movable = projectGroups(groups);

  return (
    <section className="border border-hairline bg-canvas" aria-label="Patched aliases">
      {/* Rack label strip: the column legend of the patchbay. */}
      <header className="flex items-center gap-x-4 border-b border-hairline bg-raised px-4 py-2.5 md:px-8">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">Patchbay</h2>
        <span className="mono text-[11px] text-muted">
          {aliases.length} {aliases.length === 1 ? "alias" : "aliases"}
          {aliases.length > 0 ? <span className="text-faint"> · {live} live</span> : null}
        </span>
        {applying ? (
          <span
            data-testid="applying-indicator"
            role="status"
            className="ml-auto flex items-center gap-1.5 text-[11px] text-accent"
          >
            <Spinner />
            applying…
          </span>
        ) : null}
        {/* These two widths mirror the row's port and action columns so the
            legend sits exactly above them. */}
        <span
          className={`hidden w-[4.5rem] text-right text-[10px] uppercase tracking-[0.18em] text-faint sm:block ${
            applying ? "" : "ml-auto"
          }`}
        >
          Port
        </span>
        <span aria-hidden="true" className="hidden w-[11rem] sm:block" />
      </header>

      {loading && aliases.length === 0 ? (
        <ul className="divide-y divide-hairline" aria-busy="true">
          {[0, 1].map((i) => (
            <li key={i} className="flex items-center gap-4 px-4 py-4 md:px-8">
              <span className="h-3.5 w-3.5 rounded-full bg-sunken" />
              <span className="h-4 w-40 bg-sunken" />
              <span className="hidden h-px flex-1 bg-hairline sm:block" />
              <span className="h-4 w-10 bg-sunken" />
            </li>
          ))}
        </ul>
      ) : aliases.length === 0 ? (
        <EmptyState
          data-testid="alias-empty"
          title="Nothing patched yet"
          figure={
            <figure className="select-none">
              <div className="flex items-center gap-3">
                <span className="mono shrink-0 text-[15px] text-ink">
                  myapp<span className="text-faint">.{tld}</span>
                </span>
                <span className="min-w-[2rem] flex-1">
                  <PatchCable status="up" size="figure" />
                </span>
                <span className="mono shrink-0 text-[15px] text-ink">
                  <span className="text-faint">:</span>3000
                </span>
              </div>
            </figure>
          }
        >
          An alias is one patch cable: a name your browser can resolve on the left, the port your
          dev server already listens on at the right. Nothing about your project changes — no proxy
          config, no environment variables. Patch your first one above.
        </EmptyState>
      ) : (
        groups.map((group) => (
          <div key={group.path ?? "unassigned"} data-testid="alias-group" data-project={group.path ?? "unassigned"}>
            <GroupHeader group={group} home={home} />
            <ul className="divide-y divide-hairline">
              {group.aliases.map((alias) => (
                <AliasRow
                  key={alias.id}
                  alias={alias}
                  aliases={aliases}
                  tld={tld}
                  projects={movable}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                  onSetProject={onSetProject}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/** A recessed divider strip: quieter than the rack header, louder than a row. */
function GroupHeader({ group, home }: { group: AliasGroup; home: string }) {
  const unassigned = group.path === null;

  return (
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-y border-hairline bg-sunken px-4 py-2 first:border-t-0 md:px-8">
      <span className="flex items-center gap-2 text-[12px] font-medium tracking-tight text-ink">
        {unassigned ? null : <IconFolder className="shrink-0 text-faint" />}
        {group.name}
      </span>
      <span className="mono min-w-0 truncate text-[11px] text-faint" title={group.path ?? undefined}>
        {unassigned ? "no folder — these aliases belong to nothing" : abbreviateHome(group.path!, home)}
      </span>
      <span className="mono ml-auto shrink-0 text-[11px] text-muted">
        {group.aliases.length}
        {group.live > 0 ? <span className="text-faint"> · {group.live} live</span> : null}
      </span>
    </header>
  );
}
