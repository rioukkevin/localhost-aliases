"use client";

import type { Project } from "@localhost-aliases/core";
import { Banner } from "./Banner.tsx";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { PatchCable } from "./PatchCable.tsx";
import { ProjectCard } from "./ProjectCard.tsx";
import { ProjectLinkForm } from "./ProjectLinkForm.tsx";
import { WORKSPACE_FILENAME } from "../lib/client/paths.ts";
import { useProjects } from "../lib/client/useProjects.ts";

/** Sole owner of the projects store; everything below is presentational. */
export function ProjectsView({ home }: { home: string }) {
  const store = useProjects();
  // Aliases with no folder never show up in a card, so say so rather than let
  // the page quietly disagree with the alias count in the status strip.
  const unlinked = store.aliases.filter((alias) => alias.projectPath === null);

  function writeWorkspace(project: Project) {
    void store.link(
      project.path,
      project.aliases.map((alias) => ({
        name: alias.name,
        port: alias.port,
        ...(alias.description ? { description: alias.description } : {}),
      })),
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {store.loadError ? (
        <Banner
          tone="danger"
          title="The dashboard API is not answering"
          actions={
            <Button size="sm" onClick={() => void store.refresh()}>
              Retry
            </Button>
          }
        >
          {store.loadError}
        </Banner>
      ) : null}

      <ProjectLinkForm
        aliases={store.aliases}
        home={home}
        tld={store.tld}
        busy={store.busyPath !== null}
        onLink={async (path, name, port) =>
          (await store.link(path, [{ name, port }])) !== null
        }
      />

      {store.loading && store.projects.length === 0 ? (
        <section className="border border-hairline bg-canvas" aria-busy="true">
          <div className="flex items-center gap-4 px-4 py-4 md:px-6">
            <span className="h-4 w-32 bg-sunken" />
            <span className="hidden h-px flex-1 bg-hairline sm:block" />
          </div>
        </section>
      ) : store.projects.length === 0 ? (
        <section className="border border-hairline bg-canvas">
          <EmptyState
            data-testid="project-empty"
            title="No folders linked yet"
            figure={
              <figure className="select-none">
                <div className="flex items-center gap-3">
                  <span className="mono shrink-0 text-[13px] text-muted">~/code/myapp</span>
                  <span className="min-w-[2rem] flex-1">
                    <PatchCable status="up" size="figure" />
                  </span>
                  <span className="mono shrink-0 text-[13px] text-ink">myapp.{store.tld}</span>
                </div>
              </figure>
            }
          >
            A project here is simply a folder that one or more aliases point at. Link one above, or
            let a coding agent do it through the MCP tool{" "}
            <span className="mono text-ink">link_project</span>. Once a folder is linked you can
            drop an optional <span className="mono text-ink">{WORKSPACE_FILENAME}</span> into it so
            the names travel with the repo.
          </EmptyState>
        </section>
      ) : (
        <div className="flex flex-col gap-5">
          {store.projects.map((project) => (
            <ProjectCard
              key={project.path}
              project={project}
              home={home}
              busy={store.busyPath === project.path}
              onWriteWorkspace={writeWorkspace}
            />
          ))}
        </div>
      )}

      {unlinked.length > 0 ? (
        <p data-testid="projects-unlinked" className="text-[12px] leading-relaxed text-muted">
          {unlinked.length === 1 ? "One alias is" : `${unlinked.length} aliases are`} not attached
          to a folder, so {unlinked.length === 1 ? "it does" : "they do"} not appear above:{" "}
          <span className="mono text-ink">
            {unlinked.map((alias) => alias.hostname).join(", ")}
          </span>
          . Linking the same name to a folder above attaches it.
        </p>
      ) : null}
    </div>
  );
}
