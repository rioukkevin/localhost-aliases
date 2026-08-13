"use client";

import { SettingsView } from "../../components/settings/SettingsView.tsx";
import { PageBody, PageHeader } from "../../components/ui/PageHeader.tsx";

export default function SettingsPage() {
  return (
    <PageBody>
      <PageHeader title="Settings">
        The few things that are global: the TLD every name ends in, where the dashboard itself
        listens, and the way out.
      </PageHeader>
      <SettingsView />
    </PageBody>
  );
}
