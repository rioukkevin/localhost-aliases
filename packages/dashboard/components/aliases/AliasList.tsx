"use client";

import type { AliasView, CreateAliasInput } from "@localhost-aliases/core/types";
import { countLabel, folderName, tildePath } from "../../lib/client/format.ts";
import { Spinner } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PatchCable } from "../ui/PatchCable.tsx";
import { Panel } from "../ui/Panel.tsx";
import { AliasRow } from "./AliasRow.tsx";

export interface AliasListProps {
  aliases: AliasView[];
  tld: string;
  loaded: boolean;
  busy: boolean;
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onSave: (id: string, input: CreateAliasInput) => Promise<void>;
  onDelete: (alias: AliasView) => Promise<void>;
  onDetach: (alias: AliasView) => Promise<void>;
}

interface Group {
  key: string;
  label: string;
  note: string | null;
  aliases: AliasView[];
}

/** Reserved first, then one group per folder by name, then everything unassigned. */
function groupAliases(aliases: AliasView[]): Group[] {
  const reserved = aliases.filter((a) => a.reserved);
  const byFolder = new Map<string, AliasView[]>();
  const loose: AliasView[] = [];

  for (const alias of aliases) {
    if (alias.reserved) continue;
    if (alias.projectPath) {
      const list = byFolder.get(alias.projectPath) ?? [];
      list.push(alias);
      byFolder.set(alias.projectPath, list);
    } else {
      loose.push(alias);
    }
  }

  const groups: Group[] = [];
  if (reserved.length > 0) {
    groups.push({
      key: "__reserved",
      label: "the dashboard itself",
      note: "reserved — it cannot be renamed or deleted",
      aliases: reserved,
    });
  }
  for (const path of [...byFolder.keys()].sort()) {
    groups.push({
      key: path,
      label: folderName(path),
      note: tildePath(path),
      aliases: byFolder.get(path)!,
    });
  }
  if (loose.length > 0) {
    groups.push({
      key: "__unassigned",
      label: "no folder",
      note: "these aliases belong to nothing — that is fine",
      aliases: loose,
    });
  }
  return groups;
}

export function AliasList(props: AliasListProps) {
  const { aliases, tld, loaded, busy } = props;
  const live = aliases.filter((a) => a.status === "up").length;
  const groups = groupAliases(aliases);

  return (
    <Panel
      title="patchbay"
      meta={loaded ? `${countLabel(aliases.length, "alias", "aliases")} · ${live} live` : "…"}
      padded={false}
      aside={
        busy ? (
          <span role="status" className="flex items-center gap-1.5 text-[11px] text-accent">
            <Spinner />
            applying…
          </span>
        ) : null
      }
      data-testid="patchbay"
    >
      {/* Column legend. The two spacers repeat the row widths so "Port" sits above the ports. */}
      <div className="hidden items-center gap-x-4 border-b border-hairline px-4 py-1.5 sm:flex md:px-8">
        <span className="w-3.5 shrink-0" />
        <span className="flex-1 text-[10px] font-medium uppercase tracking-[0.18em] text-faint lg:w-[22rem] lg:flex-none">
          Name
        </span>
        <span className="flex-1" />
        <span className="w-[4.5rem] text-right text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
          Port
        </span>
        <span className="w-[11rem] shrink-0" />
      </div>

      {!loaded ? (
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
      ) : aliases.length === 0 ? (
        <EmptyState
          title="Nothing patched yet"
          figure={
            <div className="flex items-center gap-3 opacity-70">
              <span className="mono text-[15px] text-faint">myapp.{tld}</span>
              <PatchCable status="up" size="figure" className="flex-1" />
              <span className="mono text-[15px] text-faint">:3000</span>
            </div>
          }
        >
          Give a dev server a real hostname. Your servers keep listening on 127.0.0.1 exactly
          as they do now — an alias only adds a name in front of one.
        </EmptyState>
      ) : (
        groups.map((group) => (
          <section key={group.key}>
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 bg-sunken px-4 py-2 md:px-8">
              <h3 className="mono text-[12px] text-ink">{group.label}</h3>
              {group.note ? <p className="text-[11px] text-faint">{group.note}</p> : null}
              <p className="ml-auto text-[10px] uppercase tracking-[0.16em] text-faint">
                {countLabel(group.aliases.length, "alias", "aliases")}
              </p>
            </header>
            <ul className="divide-y divide-hairline">
              {group.aliases.map((alias) => (
                <AliasRow
                  key={alias.id}
                  alias={alias}
                  aliases={aliases}
                  tld={tld}
                  editing={props.editingId === alias.id}
                  onEdit={props.onEdit}
                  onSave={props.onSave}
                  onDelete={props.onDelete}
                  onDetach={props.onDetach}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </Panel>
  );
}
