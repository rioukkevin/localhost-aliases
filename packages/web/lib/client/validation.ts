/**
 * Client mirror of the core validation rules, so the form can show an error
 * BEFORE the user submits.
 *
 * It is deliberately a copy and not an import: `@localhost-aliases/core` is a Bun
 * barrel (node:os, Bun.file, Bun.connect) and cannot be bundled for the browser.
 * The server re-validates with the real `assertValidAlias`, which stays the
 * authority — this file only ever *predicts* a rejection.
 */
import type { AliasView } from "@localhost-aliases/core";

/** Mirrors RESERVED_NAMES in packages/core/src/types.ts. */
export const RESERVED_NAMES = ["localhost", "broadcasthost", "local"];

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;

/** trim, lowercase, strip trailing dots — same normalization as core. */
export function normalizeName(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\.+$/, "");
}

/** `null` when the name is acceptable, otherwise the message to show inline. */
export function nameError(raw: string, aliases: AliasView[], excludeId?: string): string | null {
  const value = normalizeName(raw);
  if (value.length === 0) return null; // empty is "not yet filled in", not an error
  if (value.length > MAX_HOSTNAME_LENGTH) {
    return `Too long — at most ${MAX_HOSTNAME_LENGTH} characters.`;
  }
  if (RESERVED_NAMES.includes(value)) {
    return `"${value}" is reserved by the system and cannot be used.`;
  }
  for (const label of value.split(".")) {
    if (label.length === 0) return "Contains an empty label — check the dots.";
    if (label.length > MAX_LABEL_LENGTH) {
      return `"${label}" is longer than ${MAX_LABEL_LENGTH} characters.`;
    }
    if (!LABEL_RE.test(label)) {
      return "Use only a-z, 0-9 and hyphens; a label cannot start or end with a hyphen.";
    }
  }
  if (aliases.some((a) => a.id !== excludeId && normalizeName(a.name) === value)) {
    return `"${value}" is already patched.`;
  }
  return null;
}

/** `null` when the port is acceptable. Accepts the raw input string from the field. */
export function portError(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!/^\d+$/.test(value)) return "Ports are digits only.";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Must be between 1 and 65535.";
  }
  return null;
}

/**
 * Not an error: two aliases may legitimately point at the same dev server.
 * Still worth surfacing, because it is usually a typo.
 */
export function portWarning(raw: string, aliases: AliasView[], excludeId?: string): string | null {
  if (portError(raw) !== null) return null;
  const port = Number(raw.trim());
  if (!Number.isInteger(port)) return null;
  const other = aliases.find((a) => a.id !== excludeId && a.port === port);
  return other ? `${other.hostname} already listens on this port.` : null;
}

export function isSubmittable(name: string, port: string): boolean {
  return (
    normalizeName(name).length > 0 &&
    port.trim().length > 0 &&
    nameError(name, []) === null &&
    portError(port) === null
  );
}
