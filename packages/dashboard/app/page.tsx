"use client";

import { useState } from "react";
import { IP_POOL_END, IP_POOL_START } from "@localhost-aliases/core/types";
import { UnassignedList } from "../components/aliases/UnassignedList.tsx";
import { ProjectDrawer } from "../components/projects/ProjectDrawer.tsx";
import { ProjectGrid } from "../components/projects/ProjectGrid.tsx";
import { useProjects } from "../components/projects/useProjects.ts";
import { Banner } from "../components/ui/Banner.tsx";
import { PageBody, PageHeader } from "../components/ui/PageHeader.tsx";
import { useStatus } from "../lib/client/status-store.ts";

const POOL_SIZE = IP_POOL_END - IP_POOL_START + 1;

/**
 * The whole dashboard, on one page: folders as a grid, their aliases behind a drawer,
 * and everything that belongs to no folder listed underneath. There is no navigation
 * because there is nowhere else to go.
 */
export default function DashboardPage() {
  const { aliases, config, loaded, busy } = useStatus();
  const { projects, linking, writing, addProject, writeWorkspace } = useProjects();
  const [openPath, setOpenPath] = useState<string | null>(null);

  const open = projects.find((p) => p.path === openPath) ?? null;
  const tld = config?.tld ?? "local";
  const full = aliases.length >= POOL_SIZE;

  return (
    <PageBody>
      <PageHeader title="Patchbay">
        One name per dev server. A name points at a loopback address, and a raw TCP forward
        splices port 80 there to the port your server already listens on — so WebSockets and
        HMR pass straight through. Project aliases are <span className="mono">http://</span>{" "}
        only: nothing sits in the traffic path, so there is nothing that could terminate TLS.
      </PageHeader>

      <div className="flex flex-col gap-6">
        {full ? (
          <Banner tone="warn" title="The loopback pool is full">
            All {POOL_SIZE} addresses from 127.0.0.2 to 127.0.0.{IP_POOL_END} are allocated.
            Delete an alias to free one.
          </Banner>
        ) : null}

        <ProjectGrid
          projects={projects}
          loaded={loaded}
          linking={linking}
          onAdd={(path) => void addProject(path)}
          onOpen={setOpenPath}
        />

        <UnassignedList aliases={aliases} tld={tld} loaded={loaded} busy={busy} />
      </div>

      <ProjectDrawer
        project={open}
        aliases={aliases}
        tld={tld}
        writing={writing}
        onClose={() => setOpenPath(null)}
        onWriteWorkspace={writeWorkspace}
      />
    </PageBody>
  );
}
