import { homedir } from "node:os";
import { PageBody, PageHeader } from "../../components/PageHeader.tsx";
import { ProjectsView } from "../../components/ProjectsView.tsx";

export const dynamic = "force-dynamic";

/**
 * Server component: the browser has no way to know $HOME, and every path on this
 * page is shown abbreviated to `~`, so it is resolved here and passed down.
 */
export default function Page() {
  return (
    <PageBody>
      <PageHeader title="Projects">
        Folders your aliases belong to. Grouping is derived from each alias&apos; project path —
        nothing is scanned, and no folder is touched unless you write its workspace file.
      </PageHeader>

      <ProjectsView home={homedir()} />
    </PageBody>
  );
}
