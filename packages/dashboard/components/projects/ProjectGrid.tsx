"use client";

import { countLabel } from "../../lib/client/format.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { IconPlus } from "../ui/Icons.tsx";
import { Panel } from "../ui/Panel.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import { ProjectCard } from "./ProjectCard.tsx";
import type { ProjectSummary } from "./useProjects.ts";

export interface ProjectGridProps {
  projects: ProjectSummary[];
  loaded: boolean;
  linking: boolean;
  onAdd: (path: string) => void;
  onOpen: (path: string) => void;
}

/**
 * The whole navigation of the app: one card per folder, one column on a narrow window,
 * and an add-a-folder cell that is always the last card so it never moves under your
 * cursor as projects come and go.
 */
export function ProjectGrid({ projects, loaded, linking, onAdd, onOpen }: ProjectGridProps) {
  const live = projects.reduce((n, p) => n + p.live, 0);

  return (
    <Panel
      title="projects"
      meta={loaded ? `${countLabel(projects.length, "folder")} · ${live} live` : "…"}
      data-testid="project-grid"
    >
      {loaded && projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          figure={
            <div className="flex items-center justify-center gap-3 text-faint">
              <IconFolderFigure />
            </div>
          }
          actions={
            <FolderPicker
              value={null}
              onChange={(path) => path && onAdd(path)}
              label="Project folder"
              hideLabel
              disabled={linking}
            />
          }
        >
          A project here is nothing but a folder that some aliases point at — no config, no
          registration. Pick the folder your dev server runs in and any names you patch to it
          gather under one card. If that folder already carries a{" "}
          <span className="mono text-ink">.localhost-aliases.json</span>, its names are adopted
          the moment you pick it.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.path} project={project} onOpen={onOpen} />
          ))}

          <div
            data-testid="add-project"
            className="flex min-w-0 flex-col gap-3 rounded-[2px] border border-dashed border-hairline-strong bg-canvas p-4"
          >
            <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <IconPlus />
              Add a project
            </p>
            <p className="text-[11px] leading-relaxed text-muted">
              A folder becomes a project the moment an alias points at it.
            </p>
            <div className="mt-auto">
              <FolderPicker
                value={null}
                onChange={(path) => path && onAdd(path)}
                label="Project folder"
                hideLabel
                disabled={linking}
              />
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** A folder with a cable leaving it — the empty grid's one picture. */
function IconFolderFigure() {
  return (
    <svg
      width="120"
      height="56"
      viewBox="0 0 120 56"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 44V12h16l5 7h28v25z" />
      <path d="M57 31h24" strokeDasharray="6 6" opacity="0.55" />
      <circle cx="90" cy="31" r="7" opacity="0.55" />
      <circle cx="90" cy="31" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
