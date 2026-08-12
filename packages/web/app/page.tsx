import { homedir } from "node:os";
import { PageBody, PageHeader } from "../components/PageHeader.tsx";
import { AliasesView } from "../components/AliasesView.tsx";

export const dynamic = "force-dynamic";

/**
 * Server component: project paths render abbreviated to `~`, and the browser cannot
 * know $HOME, so it is resolved here and passed down — same as /projects.
 */
export default function Page() {
  return (
    <PageBody>
      <PageHeader title="Aliases">
        Every alias patches a hostname into a local port, grouped by the project it belongs to.
        Names resolve through <span className="mono text-ink">/etc/hosts</span>; traffic is routed
        by the privileged helper.
      </PageHeader>

      <AliasesView home={homedir()} />
    </PageBody>
  );
}
