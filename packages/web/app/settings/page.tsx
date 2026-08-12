import { PageBody, PageHeader } from "../../components/PageHeader.tsx";
import { SettingsView } from "../../components/SettingsView.tsx";
import { WEB_AGENT_LABEL } from "../../lib/client/commands.ts";

export const dynamic = "force-dynamic";

/**
 * launchd exports XPC_SERVICE_NAME with the job label to the processes it spawns.
 * It is the only launch-at-login evidence available from inside this process —
 * the alternative would be shelling out to `launchctl`, which the dashboard does
 * not do. Read here because it is a server-side fact.
 */
export default function Page() {
  const startedByLaunchAgent = process.env.XPC_SERVICE_NAME === WEB_AGENT_LABEL;

  return (
    <PageBody>
      <PageHeader title="Settings">
        What every alias is named, which ports the privileged helper owns, and how this dashboard
        itself is started. Nothing here is applied until you press apply.
      </PageHeader>

      <SettingsView startedByLaunchAgent={startedByLaunchAgent} />
    </PageBody>
  );
}
