import { homedir } from "node:os";
import { PageBody, PageHeader } from "../../components/PageHeader.tsx";
import { McpView } from "../../components/McpView.tsx";
import { fallbackSpec } from "./fallback-spec.ts";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <PageBody>
      <PageHeader title="MCP">
        Let a coding agent read and create aliases for you. Everything it can do is listed below —
        read it before you install, not after.
      </PageHeader>

      <McpView
        home={homedir()}
        dashboardPort={Number(process.env.LA_DASHBOARD_PORT ?? 7788)}
        fallback={fallbackSpec()}
      />
    </PageBody>
  );
}
