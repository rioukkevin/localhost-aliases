"use client";

import { useState } from "react";
import { errorMessage, pickFolder } from "../../lib/client/api.ts";
import { tildePath } from "../../lib/client/format.ts";
import { isAbsolutePath } from "../../lib/client/validate.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { IconClose, IconFolder } from "../ui/Icons.tsx";
import { TextField } from "../ui/TextField.tsx";

export interface FolderPickerProps {
  value: string | null;
  onChange: (path: string | null) => void;
  label?: string;
  /** Screen-reader-only label, for dense inline forms. */
  hideLabel?: boolean;
  disabled?: boolean;
}

/**
 * The native folder dialog, opened by the app on the server side. The dialog can fail
 * (no app running it, user closes it, sandbox refuses) — in that case the manual
 * absolute-path field is the way through, so it is always one click away.
 */
export function FolderPicker({
  value,
  onChange,
  label = "Project folder",
  hideLabel = false,
  disabled = false,
}: FolderPickerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState("");

  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const path = await pickFolder();
      // null means the user cancelled the dialog: not an error, not a change.
      if (path) onChange(path);
    } catch (err) {
      setError(errorMessage(err));
      setManual(true);
    } finally {
      setBusy(false);
    }
  }

  const draftError = draft.trim() !== "" && !isAbsolutePath(draft.trim())
    ? "Enter an absolute path, starting with /."
    : null;

  function commitDraft() {
    const path = draft.trim();
    if (path === "" || draftError) return;
    onChange(path);
    setDraft("");
    setManual(false);
    setError(null);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="folder-picker">
      <span
        className={
          hideLabel ? "sr-only" : "text-[10px] font-medium uppercase tracking-[0.16em] text-faint"
        }
      >
        {label}
      </span>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="md"
          busy={busy}
          disabled={disabled}
          onClick={choose}
          data-testid="folder-picker-choose"
        >
          {busy ? null : <IconFolder />}
          {busy ? "waiting for the dialog…" : value ? "Change folder…" : "Choose folder…"}
        </Button>

        {value ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="mono truncate text-[12px] text-ink" title={value}>
              {tildePath(value)}
            </span>
            <IconButton
              label="Clear folder"
              onClick={() => onChange(null)}
              disabled={disabled}
              data-testid="folder-picker-clear"
            >
              <IconClose />
            </IconButton>
          </span>
        ) : (
          <span className="text-[12px] text-faint">no folder — optional</span>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-[11px] leading-snug text-danger">
          {error} Type the path instead.
        </p>
      ) : null}

      {manual ? (
        <div className="flex items-end gap-2">
          <TextField
            label="Absolute path"
            hideLabel
            className="flex-1"
            placeholder="/Users/you/code/myapp"
            value={draft}
            error={draftError}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              }
            }}
            data-testid="folder-picker-manual"
          />
          <Button size="md" onClick={commitDraft} disabled={draft.trim() === "" || !!draftError}>
            Use path
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setManual(true)}
          className="self-start text-[11px] text-faint underline-offset-2 hover:text-muted hover:underline"
        >
          or type an absolute path
        </button>
      )}
    </div>
  );
}
