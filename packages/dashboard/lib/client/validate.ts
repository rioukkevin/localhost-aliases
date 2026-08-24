"use client";

/**
 * Client-side mirror of core's alias rules, so the form can say what is wrong before
 * anything is submitted. The server re-validates with core; this is only the fast path.
 * The messages are kept identical to core's so a rejected submit never contradicts
 * what the field already said.
 */
import type { AliasView } from "@localhost-aliases/core/types";
import { RESERVED_ALIAS_NAME, RESERVED_NAMES, blockedTldReason } from "@localhost-aliases/core/types";

const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface AliasFormContext {
  aliases: readonly AliasView[];
  tld: string;
  /** Id of the alias being edited; it is skipped by the duplicate checks. */
  excludeId?: string;
}

export interface AliasFormIssues {
  name: string | null;
  port: string | null;
  /** Non-blocking: two aliases may legitimately point at one dev server. */
  portWarning: string | null;
}

export function validateName(raw: string, ctx: AliasFormContext): string | null {
  const name = raw.trim().toLowerCase();
  if (name === "") return "A name is required.";
  if (raw.trim() !== name) return "Use lowercase letters only.";
  if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) {
    return "Dots must separate parts, e.g. api.myapp.";
  }
  for (const label of name.split(".")) {
    if (label.length > MAX_LABEL_LENGTH) {
      return `Each part must be ${MAX_LABEL_LENGTH} characters or fewer.`;
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return "Parts cannot start or end with a hyphen.";
    }
    if (!LABEL_RE.test(label)) return "Use letters, digits and hyphens only.";
  }
  if (`${name}.${ctx.tld}`.length > MAX_HOSTNAME_LENGTH) {
    return `The full hostname must be ${MAX_HOSTNAME_LENGTH} characters or fewer.`;
  }
  if ((RESERVED_NAMES as readonly string[]).includes(name)) {
    return `"${name}" is reserved by macOS and cannot be used.`;
  }
  if (name === RESERVED_ALIAS_NAME) return `"${RESERVED_ALIAS_NAME}" is reserved for the dashboard.`;
  if (ctx.aliases.some((a) => a.id !== ctx.excludeId && a.name.toLowerCase() === name)) {
    return `"${name}" already exists.`;
  }
  return null;
}

export function validatePort(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "A port is required.";
  if (!/^\d+$/.test(trimmed)) return "Port must be a whole number between 1 and 65535.";
  const port = Number(trimmed);
  if (port < 1 || port > 65535) return "Port must be a whole number between 1 and 65535.";
  return null;
}

function portWarning(raw: string, ctx: AliasFormContext): string | null {
  if (validatePort(raw)) return null;
  const port = Number(raw.trim());
  const clash = ctx.aliases.find((a) => a.id !== ctx.excludeId && a.port === port);
  return clash ? `${clash.hostname} already forwards to this port.` : null;
}

export function validateAliasForm(
  values: { name: string; port: string },
  ctx: AliasFormContext,
): AliasFormIssues {
  return {
    name: validateName(values.name, ctx),
    port: validatePort(values.port),
    portWarning: portWarning(values.port, ctx),
  };
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !path.includes("//") && path.trim() === path;
}

/**
 * Shape, then core's blocklist verbatim — so the field says the same specific sentence the
 * server would, rather than letting the user save a suffix that fails silently in a browser.
 */
export function validateTld(raw: string): string | null {
  const tld = raw.trim().toLowerCase();
  if (tld === "") return "A TLD is required.";
  if (raw.trim() !== tld) return "Use lowercase letters only.";
  if (tld.startsWith(".")) return "Leave out the leading dot.";
  for (const label of tld.split(".")) {
    if (!LABEL_RE.test(label) || label.length > MAX_LABEL_LENGTH) {
      return "Use letters, digits and hyphens only.";
    }
  }
  return blockedTldReason(tld);
}

/** The dashboard binds a high port on 127.0.0.1; below 1024 would need root. */
export function validateDashboardPort(raw: string): string | null {
  const base = validatePort(raw);
  if (base) return base;
  const port = Number(raw.trim());
  if (port < 1024) return "Use a port above 1024 — the dashboard runs as you, not as root.";
  return null;
}
