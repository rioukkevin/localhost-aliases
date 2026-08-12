"use client";

import { useMemo } from "react";
import { useAliases } from "../lib/client/useAliases.ts";
import { groupAliases } from "../lib/client/grouping.ts";
import { AliasCreateForm } from "./AliasCreateForm.tsx";
import { AliasList } from "./AliasList.tsx";
import { Banner } from "./Banner.tsx";
import { Button } from "./Button.tsx";
import { HelperBanner } from "./HelperBanner.tsx";

/**
 * Sole owner of the alias store on this page. Everything below this component is
 * presentational and receives its data through props.
 */
export function AliasesView({ home }: { home: string }) {
  const store = useAliases();
  const tld = store.status?.tld ?? "local";
  const groups = useMemo(() => groupAliases(store.aliases), [store.aliases]);

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
      ) : (
        <HelperBanner status={store.status} />
      )}

      <AliasCreateForm
        aliases={store.aliases}
        tld={tld}
        https={store.status?.https ?? false}
        busy={store.applying}
        onCreate={store.create}
      />

      <AliasList
        groups={groups}
        aliases={store.aliases}
        tld={tld}
        home={home}
        loading={store.loading}
        applying={store.applying}
        onUpdate={store.update}
        onDelete={store.remove}
        onSetProject={store.setProject}
      />
    </div>
  );
}
