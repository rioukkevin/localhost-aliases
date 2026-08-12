"use client";

/**
 * The name + port pair every "create an alias" form collects, with its
 * pre-submit validation and focus behaviour.
 *
 * There are three such forms now (the patchbay's quick create, "new project"
 * and "add an alias to this project") and they must reject exactly the same
 * things in exactly the same way — so the rules live here once rather than
 * being re-typed per form.
 */
import { useMemo, useRef, useState } from "react";
import type { AliasView } from "@localhost-aliases/core";
import { nameError, normalizeName, portError, portWarning } from "./validation.ts";

export interface AliasDraft {
  name: string;
  setName: (value: string) => void;
  port: string;
  setPort: (value: string) => void;
  /** Blocking problem, or null. "Required" only appears after a submit attempt. */
  nameIssue: string | null;
  portIssue: string | null;
  /** Non-blocking note: another alias already uses this port. */
  portNote: string | null;
  nameRef: React.RefObject<HTMLInputElement | null>;
  portRef: React.RefObject<HTMLInputElement | null>;
  /** Normalized name, or "" — used for live previews. */
  preview: string;
  reset: () => void;
  /** Focuses the offending field and returns null when the draft is not valid. */
  validate: () => { name: string; port: number } | null;
}

export function useAliasDraft(aliases: AliasView[], initialName = ""): AliasDraft {
  const [name, setName] = useState(initialName);
  const [port, setPort] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  const nameIssue = useMemo(
    () => nameError(name, aliases) ?? (submitted && name.trim() === "" ? "Give it a name." : null),
    [name, aliases, submitted],
  );
  const portIssue = useMemo(
    () => portError(port) ?? (submitted && port.trim() === "" ? "Pick a port." : null),
    [port, submitted],
  );
  const portNote = useMemo(() => portWarning(port, aliases), [port, aliases]);

  return {
    name,
    setName,
    port,
    setPort,
    nameIssue,
    portIssue,
    portNote,
    nameRef,
    portRef,
    preview: normalizeName(name),
    reset: () => {
      setName("");
      setPort("");
      setSubmitted(false);
    },
    validate: () => {
      setSubmitted(true);
      const clean = normalizeName(name);
      if (clean === "" || nameError(name, aliases) !== null) {
        nameRef.current?.focus();
        return null;
      }
      if (port.trim() === "" || portError(port) !== null) {
        portRef.current?.focus();
        return null;
      }
      return { name: clean, port: Number(port.trim()) };
    },
  };
}
