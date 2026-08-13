"use client";

import { ProjectsView } from "../../components/projects/ProjectsView.tsx";
import { PageBody, PageHeader } from "../../components/ui/PageHeader.tsx";

export default function ProjectsPage() {
  return (
    <PageBody>
      <PageHeader title="Projects">
        A project is just a folder that some aliases point at. The grouping is a convenience —
        an alias with no folder works exactly the same.
      </PageHeader>
      <ProjectsView />
    </PageBody>
  );
}
