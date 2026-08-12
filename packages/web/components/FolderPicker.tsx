"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button, IconButton, Spinner } from "./Button.tsx";
import { IconClose } from "./Icons.tsx";
import {
  abbreviateUserHome,
  requestFolder,
  submitFolderPath,
} from "../lib/client/folder-picker.ts";

export interface FolderPickerProps {
  value: string | null;
  onChange: (path: string | null) => void;
  label?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

/** Folder glyph, local to this component so shared Icons.tsx stays untouched. */
function IconFolder() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
      <path
        d="M1.5 3.25h3.6l1 1.4h6.4v6.1a.75.75 0 0 1-.75.75H2.25a.75.75 0 0 1-.75-.75V3.25Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Picks a folder with the real macOS chooser (`POST /api/pick-folder`), with a
 * typed-path fallback for anyone the dialog does not work for.
 *
 * The dialog is a *native* modal: the browser tab keeps running while it is open,
 * so the waiting state has to say where the window went — "look behind your
 * browser" is the difference between "it's loading" and "nothing happened".
 */
export function FolderPicker({
  value,
  onChange,
  label,
  disabled = false,
  "data-testid": testId = "folder-picker",
}: FolderPickerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const locked = disabled || busy;

  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestFolder();
      // A cancel is a normal outcome, not a failure: leave the value alone.
      if ("path" in result) {
        onChange(result.path);
        setManual(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // The dialog is the thing that just failed, so offer the way that cannot.
      setManual(true);
    } finally {
      setBusy(false);
    }
  }

  async function onManualSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitFolderPath(draft);
      if ("path" in result) {
        onChange(result.path);
        setManual(false);
        setDraft("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function openManual() {
    setManual(true);
    setError(null);
    setDraft(value ?? "");
    // Focus after the input exists.
    queueMicrotask(() => inputRef.current?.focus());
  }

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1.5">
      {label ? (
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          {label}
        </span>
      ) : null}

      {value ? (
        <div className="flex min-w-0 items-center gap-2 border border-hairline-strong bg-sunken py-1.5 pl-2.5 pr-1.5">
          <span className="text-faint">
            <IconFolder />
          </span>
          <span
            data-testid={`${testId}-path`}
            title={value}
            className="mono min-w-0 flex-1 truncate text-[13px] text-ink"
          >
            {abbreviateUserHome(value)}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={choose}
            busy={busy}
            disabled={disabled}
            aria-label={`Change folder, currently ${value}`}
            data-testid={`${testId}-choose`}
          >
            Change
          </Button>
          <IconButton
            label="Clear the chosen folder"
            onClick={() => {
              onChange(null);
              setError(null);
            }}
            disabled={locked}
            data-testid={`${testId}-clear`}
          >
            <IconClose />
          </IconButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={choose}
            busy={busy}
            disabled={disabled}
            aria-label="Choose a folder with the macOS folder dialog"
            data-testid={`${testId}-choose`}
          >
            <IconFolder />
            Choose folder…
          </Button>
          {manual ? null : (
            <button
              type="button"
              onClick={openManual}
              disabled={locked}
              aria-label="Type a folder path instead of using the dialog"
              data-testid={`${testId}-manual-toggle`}
              className="text-[12px] text-muted underline underline-offset-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              or type a path
            </button>
          )}
        </div>
      )}

      {/* aria-live, because the native dialog steals focus and a sighted-only
          "waiting" cue would leave a screen-reader user with silence. */}
      <p aria-live="polite" className="sr-only">
        {busy ? "Waiting for the folder dialog." : ""}
      </p>

      {busy ? (
        <p
          data-testid={`${testId}-busy`}
          className="flex items-center gap-1.5 text-[11px] leading-snug text-muted"
        >
          <Spinner />
          Waiting for the folder dialog — it may be behind your browser window.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          className="text-[11px] leading-snug text-danger"
        >
          {error}
        </p>
      ) : null}

      {manual ? (
        <form onSubmit={onManualSubmit} className="flex flex-col gap-1.5" noValidate>
          <label htmlFor={inputId} className="sr-only">
            Absolute folder path
          </label>
          <div className="flex min-w-0 items-center gap-2">
            <input
              id={inputId}
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={locked}
              spellCheck={false}
              autoComplete="off"
              placeholder="~/code/my-app"
              aria-label="Absolute folder path"
              aria-invalid={error ? true : undefined}
              data-testid={`${testId}-manual-input`}
              className={[
                "mono h-9 min-w-0 flex-1 border bg-sunken px-2.5 text-[13px] text-ink",
                "placeholder:text-faint",
                error ? "border-danger" : "border-hairline-strong",
              ].join(" ")}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={locked || draft.trim() === ""}
              aria-label="Use the typed folder path"
              data-testid={`${testId}-manual-submit`}
            >
              Use
            </Button>
            <IconButton
              label="Cancel typing a path"
              onClick={() => {
                setManual(false);
                setError(null);
              }}
              disabled={locked}
              data-testid={`${testId}-manual-cancel`}
            >
              <IconClose />
            </IconButton>
          </div>
          <p className="text-[11px] leading-snug text-faint">
            An absolute path. <span className="mono">~</span> is expanded, and the folder must
            already exist.
          </p>
        </form>
      ) : null}
    </div>
  );
}
