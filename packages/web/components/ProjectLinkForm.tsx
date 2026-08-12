"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import type { AliasView } from "@localhost-aliases/core";
import { Button } from "./Button.tsx";
import { Panel } from "./Panel.tsx";
import { TextField } from "./TextField.tsx";
import { abbreviateHome, joinPath, WORKSPACE_FILENAME } from "../lib/client/paths.ts";
import { nameError, normalizeName, portError } from "../lib/client/validation.ts";

export interface ProjectLinkFormProps {
  aliases: AliasView[];
  home: string;
  tld: string;
  busy: boolean;
  onLink: (path: string, name: string, port: number) => Promise<boolean>;
}

/**
 * Attaches a folder to an alias. A project only exists because an alias points at
 * it, so "link a folder" is really "create (or re-point) one alias with a
 * projectPath" — which is exactly what POST /api/projects/link does.
 */
export function ProjectLinkForm({ aliases, home, tld, busy, onLink }: ProjectLinkFormProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  const trimmedPath = path.trim();
  const pathIssue = useMemo(() => {
    if (trimmedPath === "") return submitted ? "Give it a folder." : null;
    // The server has its own cwd, so a relative path is meaningless to it.
    if (!trimmedPath.startsWith("/")) return "Must be an absolute path, starting with /.";
    return null;
  }, [trimmedPath, submitted]);

  // Duplicates are allowed here: linking re-points an existing alias on purpose.
  const nameIssue = useMemo(
    () => nameError(name, []) ?? (submitted && name.trim() === "" ? "Give it a name." : null),
    [name, submitted],
  );
  const portIssue = useMemo(
    () => portError(port) ?? (submitted && port.trim() === "" ? "Pick a port." : null),
    [port, submitted],
  );

  const existing = useMemo(() => {
    const value = normalizeName(name);
    return value === "" ? null : (aliases.find((a) => normalizeName(a.name) === value) ?? null);
  }, [name, aliases]);

  const filePreview =
    trimmedPath.startsWith("/") && pathIssue === null
      ? abbreviateHome(joinPath(trimmedPath, WORKSPACE_FILENAME), home)
      : `<folder>/${WORKSPACE_FILENAME}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (trimmedPath === "" || !trimmedPath.startsWith("/")) return pathRef.current?.focus();
    if (normalizeName(name) === "" || nameError(name, []) !== null) return nameRef.current?.focus();
    if (port.trim() === "" || portError(port) !== null) return portRef.current?.focus();

    const ok = await onLink(trimmedPath, normalizeName(name), Number(port.trim()));
    if (ok) {
      setPath("");
      setName("");
      setPort("");
      setSubmitted(false);
    }
  }

  return (
    <form data-testid="project-link-form" onSubmit={onSubmit} noValidate>
      <Panel
        title="Link a folder"
        footer={
          <p className="mono text-[11px] text-faint">
            {normalizeName(name) || "myapp"}.{tld}
            <span className="px-2">→</span>
            127.0.0.1:{port.trim() || "3000"}
            <span className="px-2 text-faint">·</span>
            writes {filePreview}
          </p>
        }
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-4">
          <TextField
            ref={pathRef}
            label="Folder"
            data-testid="project-path-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/code/myapp"
            autoComplete="off"
            spellCheck={false}
            error={pathIssue}
            hint="Absolute path to the project root."
            className="md:flex-1"
          />
          <TextField
            ref={nameRef}
            label="Alias"
            data-testid="project-alias-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="myapp"
            suffix={`.${tld}`}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            error={nameIssue}
            warning={
              existing
                ? `${existing.hostname} exists on :${existing.port} — it will be re-pointed here.`
                : null
            }
            hint="Created if it does not exist yet."
            className="md:w-[14rem] md:shrink-0"
          />
          <TextField
            ref={portRef}
            label="Port"
            data-testid="project-port-input"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="3000"
            prefix=":"
            inputMode="numeric"
            autoComplete="off"
            error={portIssue}
            hint="Your dev server."
            className="md:w-[8.5rem] md:shrink-0"
          />
          <div className="shrink-0 md:pt-[1.35rem]">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              data-testid="project-link-submit"
              className="h-10 px-5"
            >
              Link
            </Button>
          </div>
        </div>
      </Panel>
    </form>
  );
}
