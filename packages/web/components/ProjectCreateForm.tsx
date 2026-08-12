"use client";

import { useState, type FormEvent } from "react";
import type { AliasView, CreateAliasInput } from "@localhost-aliases/core";
import { FolderPicker } from "@/components/FolderPicker";
import { Button } from "./Button.tsx";
import { Panel } from "./Panel.tsx";
import { TextField } from "./TextField.tsx";
import { useAliasDraft } from "../lib/client/alias-draft.ts";
import { folderName } from "../lib/client/grouping.ts";
import { abbreviateHome } from "../lib/client/paths.ts";
import { normalizeName } from "../lib/client/validation.ts";

export interface ProjectCreateFormProps {
  aliases: AliasView[];
  home: string;
  tld: string;
  https: boolean;
  busy: boolean;
  onCreate: (input: CreateAliasInput) => Promise<boolean>;
}

/** A folder name is usually already a good hostname; when it is not, say nothing. */
function suggestName(path: string): string {
  const candidate = normalizeName(folderName(path).replace(/[^a-zA-Z0-9-]+/g, "-"));
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(candidate) ? candidate : "";
}

/**
 * Creating a project is choosing a folder and patching the first alias into it.
 * There is no separate "project" record anywhere — a project is exactly the set
 * of aliases that point at one folder — so this form writes one alias with a
 * `projectPath` and nothing else. The workspace file stays opt-in, per card.
 */
export function ProjectCreateForm({
  aliases,
  home,
  tld,
  https,
  busy,
  onCreate,
}: ProjectCreateFormProps) {
  const [path, setPath] = useState<string | null>(null);
  const [pathIssue, setPathIssue] = useState<string | null>(null);
  const draft = useAliasDraft(aliases);

  function onPickFolder(next: string | null) {
    setPath(next);
    setPathIssue(null);
    // Only ever a suggestion: a name the user has already typed is left alone.
    if (next && draft.name.trim() === "") draft.setName(suggestName(next));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!path) {
      setPathIssue("Choose the project folder first.");
      return;
    }
    const values = draft.validate();
    if (!values) return;

    const ok = await onCreate({ ...values, projectPath: path });
    if (ok) {
      setPath(null);
      draft.reset();
    }
  }

  const previewUrl = `${https ? "https" : "http"}://${draft.preview || "myapp"}.${tld}`;

  return (
    <form data-testid="project-create-form" onSubmit={onSubmit} noValidate>
      <Panel
        title="New project"
        footer={
          <p className="mono truncate text-[11px] text-faint">
            {path ? abbreviateHome(path, home) : "<folder>"}
            <span className="px-2">·</span>
            {previewUrl}
            <span className="px-2">→</span>
            127.0.0.1:{draft.port.trim() || "3000"}
          </p>
        }
      >
        <div className="flex flex-col gap-4">
          <FolderPicker
            value={path}
            onChange={onPickFolder}
            label="Project folder"
            disabled={busy}
            data-testid="project-folder-picker"
          />
          {pathIssue ? (
            <p role="alert" className="-mt-2 text-[11px] text-danger">
              {pathIssue}
            </p>
          ) : null}

          <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-4">
            <TextField
              ref={draft.nameRef}
              label="First alias"
              data-testid="project-name-input"
              value={draft.name}
              onChange={(e) => draft.setName(e.target.value)}
              placeholder="myapp"
              suffix={`.${tld}`}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              error={draft.nameIssue}
              hint="Suggested from the folder name; change it freely."
              className="md:flex-1"
            />
            <TextField
              ref={draft.portRef}
              label="Port"
              data-testid="project-port-input"
              value={draft.port}
              onChange={(e) => draft.setPort(e.target.value)}
              placeholder="3000"
              prefix=":"
              inputMode="numeric"
              autoComplete="off"
              error={draft.portIssue}
              warning={draft.portNote}
              hint="Where this project's dev server listens."
              className="md:w-[9.5rem] md:shrink-0"
            />
            <div className="shrink-0 md:pt-[1.35rem]">
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                data-testid="project-create-submit"
                className="h-10 px-5"
              >
                Create project
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </form>
  );
}
