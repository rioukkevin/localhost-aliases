"use client";

import { useState } from "react";
import { IP_POOL_END, IP_POOL_START } from "@localhost-aliases/core/types";
import type { CreateAliasInput, ValidationIssue } from "@localhost-aliases/core/types";
import { AliasEditor } from "../components/aliases/AliasEditor.tsx";
import { AliasList } from "../components/aliases/AliasList.tsx";
import { useAliasActions } from "../components/aliases/useAliasActions.ts";
import { Banner } from "../components/ui/Banner.tsx";
import { PageBody, PageHeader } from "../components/ui/PageHeader.tsx";
import { Panel } from "../components/ui/Panel.tsx";
import { ApiError } from "../lib/client/api.ts";
import { useStatus } from "../lib/client/status-store.ts";

const POOL_SIZE = IP_POOL_END - IP_POOL_START + 1;

export default function AliasesPage() {
  const { aliases, config, loaded, busy } = useStatus();
  const actions = useAliasActions();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Remounting the form is the whole reset: no field state survives a successful create.
  const [formKey, setFormKey] = useState(0);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const tld = config?.tld ?? "local";
  const full = aliases.length >= POOL_SIZE;

  async function create(input: CreateAliasInput) {
    setCreating(true);
    setServerIssues([]);
    try {
      await actions.create(input);
      setFormKey((n) => n + 1);
    } catch (err) {
      // The toast already said what happened; put field problems back on their fields.
      if (err instanceof ApiError) setServerIssues(err.issues);
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageBody>
      <PageHeader title="Aliases">
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

        <Panel title="new alias" meta="127.0.0.x:80 → 127.0.0.1:port">
          <AliasEditor
            key={formKey}
            aliases={aliases}
            tld={tld}
            submitLabel="Patch it"
            busy={creating}
            serverIssues={serverIssues}
            onSubmit={create}
          />
        </Panel>

        <AliasList
          aliases={aliases}
          tld={tld}
          loaded={loaded}
          busy={busy}
          editingId={editingId}
          onEdit={setEditingId}
          onSave={(id, input) => actions.update(id, input).catch(() => {})}
          onDelete={(alias) => actions.remove(alias).catch(() => {})}
          onDetach={(alias) => actions.move(alias, null).catch(() => {})}
        />
      </div>
    </PageBody>
  );
}
