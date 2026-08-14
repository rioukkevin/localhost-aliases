"use client";

import { WORKSPACE_FILENAME } from "@localhost-aliases/core/types";
import { countLabel, tildePath } from "../../lib/client/format.ts";
import { Chip } from "../ui/Chip.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import type { ProjectSummary } from "./useProjects.ts";

export interface ProjectCardProps {
  project: ProjectSummary;
  onOpen: (path: string) => void;
}

/** How many jack-lamps fit on a card before the count has to speak for them. */
const LAMPS = 8;

/**
 * One folder, as a panel face: the folder name, the path it really is, the lamps for
 * its aliases, and whether the folder carries a workspace file. Clicking it opens the
 * drawer with the actual patch cables.
 */
export function ProjectCard({ project, onOpen }: ProjectCardProps) {
  const lamps = project.aliases.slice(0, LAMPS);
  const overflow = project.aliases.length - lamps.length;

  return (
    <button
      type="button"
      data-testid="project-card"
      onClick={() => onOpen(project.path)}
      aria-label={`Open ${project.name}`}
      className="flex min-w-0 flex-col gap-3 rounded-[2px] border border-hairline bg-canvas p-4 text-left transition-colors hover:border-hairline-strong hover:bg-raised"
    >
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink">
          {project.name}
        </h3>
        {project.hasWorkspaceFile ? (
          <Chip tone="accent" className="shrink-0">
            {WORKSPACE_FILENAME}
          </Chip>
        ) : null}
      </div>

      <p className="mono truncate text-[11px] text-faint" title={project.path}>
        {tildePath(project.path)}
      </p>

      <div className="flex min-h-[1.25rem] flex-wrap items-center gap-1.5">
        {lamps.map((alias) => (
          <span key={alias.id} title={alias.hostname}>
            <StatusDot status={alias.status} />
          </span>
        ))}
        {overflow > 0 ? (
          <span className="mono text-[11px] text-faint">+{overflow}</span>
        ) : null}
        {project.aliases.length === 0 ? (
          <span className="text-[11px] text-faint">nothing patched here yet</span>
        ) : null}
      </div>

      <p className="mt-auto border-t border-hairline pt-2.5 text-[11px] text-muted">
        {countLabel(project.aliases.length, "alias", "aliases")}
        <span className="text-faint"> · </span>
        <span className={project.live > 0 ? "text-live" : undefined}>{project.live} live</span>
      </p>
    </button>
  );
}
