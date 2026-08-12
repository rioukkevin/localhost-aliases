"use client";

import { useState } from "react";
import type { AliasView } from "@localhost-aliases/core";
import { IconButton } from "./Button.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { IconUnlink } from "./Icons.tsx";
import { folderName } from "../lib/client/grouping.ts";

export interface AliasDetachButtonProps {
  alias: AliasView;
  /** Resolves false on failure; the store has already rolled back and toasted. */
  onDetach: (id: string) => Promise<boolean>;
}

/**
 * Detaching is the inverse of "created inside a project", so it gets the same
 * treatment as deleting: an explicit confirmation, then the store's optimistic
 * update with rollback. Renders nothing for an alias that has no folder.
 */
export function AliasDetachButton({ alias, onDetach }: AliasDetachButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!alias.projectPath) return null;
  const project = folderName(alias.projectPath);

  return (
    <>
      <IconButton
        label={`Detach ${alias.hostname} from ${project}`}
        data-testid="alias-detach"
        disabled={alias.id.startsWith("pending-")}
        onClick={() => setConfirming(true)}
      >
        <IconUnlink />
      </IconButton>

      <ConfirmDialog
        open={confirming}
        title={`Detach ${alias.hostname} from ${project}?`}
        confirmLabel="Detach"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setBusy(true);
          await onDetach(alias.id);
          setBusy(false);
          setConfirming(false); // the toast reports failure; the dialog always closes
        }}
      >
        The alias keeps resolving on <span className="mono">:{alias.port}</span> — it just stops
        belonging to a folder and moves to <span className="text-ink">Unassigned</span>. Nothing
        inside <span className="mono">{alias.projectPath}</span> is touched, including its{" "}
        workspace file.
      </ConfirmDialog>
    </>
  );
}
