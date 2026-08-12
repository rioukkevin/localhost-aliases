/**
 * Pure input validation for aliases, ports, forward targets and the TLD.
 *
 * Every `validate*` function returns the (possibly empty) list of issues so the
 * dashboard can render field-level errors; `assertValidAlias` is the throwing
 * entry point used by the store and the API layer.
 */
import {
  RESERVED_NAMES,
  ValidationError,
  type Alias,
  type CreateAliasInput,
  type ValidationIssue,
} from "./types.ts";

/** One DNS label: a-z 0-9 and hyphens, never leading/trailing hyphen. */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;

/** The only forward targets we accept — traffic must never leave the machine. */
export const LOOPBACK_TARGETS = ["127.0.0.1", "::1", "localhost"] as const;
export const DEFAULT_TARGET = "127.0.0.1";

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

function issue(field: string, message: string): ValidationIssue {
  return { field, message };
}

/**
 * trim, lowercase, strip trailing dots.
 *
 * NFKC first: compatibility forms (fullwidth "Ｍ", ligatures, …) fold to their
 * ASCII equivalent so two visually identical names cannot both be registered.
 * Anything left outside [a-z0-9-.] is rejected by `validateName`.
 */
export function normalizeName(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\.+$/, "");
}

/** Same normalization as a name, plus leading dots (".local" -> "local"). */
export function normalizeTld(raw: string): string {
  return normalizeName(raw).replace(/^\.+/, "");
}

function labelIssues(field: string, value: string): ValidationIssue[] {
  for (const label of value.split(".")) {
    if (label.length === 0) {
      return [issue(field, "must not contain an empty label")];
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return [issue(field, `label "${label}" must be at most ${MAX_LABEL_LENGTH} characters`)];
    }
    if (!LABEL_RE.test(label)) {
      return [
        issue(
          field,
          `label "${label}" must contain only a-z, 0-9 and hyphens, and must not start or end with a hyphen`,
        ),
      ];
    }
  }
  return [];
}

/** [] when valid. Input is normalized first, so "MyApp" is accepted as "myapp". */
export function validateName(name: string): ValidationIssue[] {
  const value = normalizeName(name);
  if (value.length === 0) return [issue("name", "is required")];
  if (value.length > MAX_HOSTNAME_LENGTH) {
    return [issue("name", `must be at most ${MAX_HOSTNAME_LENGTH} characters`)];
  }
  if ((RESERVED_NAMES as readonly string[]).includes(value)) {
    return [issue("name", `"${value}" is reserved and cannot be used`)];
  }
  return labelIssues("name", value);
}

export function validatePort(port: unknown): ValidationIssue[] {
  if (typeof port !== "number" || !Number.isInteger(port)) {
    return [issue("port", "must be an integer")];
  }
  if (port < 1 || port > 65535) {
    return [issue("port", "must be between 1 and 65535")];
  }
  return [];
}

export function validateTarget(target: string): ValidationIssue[] {
  const value = typeof target === "string" ? target.trim().toLowerCase() : "";
  if (value.length === 0) return [issue("target", "is required")];
  if (!(LOOPBACK_TARGETS as readonly string[]).includes(value)) {
    return [issue("target", `must be a loopback address (${LOOPBACK_TARGETS.join(", ")})`)];
  }
  return [];
}

export function validateTld(tld: string): ValidationIssue[] {
  const value = normalizeTld(tld);
  if (value.length === 0) return [issue("tld", "is required")];
  if (value.length > MAX_HOSTNAME_LENGTH) {
    return [issue("tld", `must be at most ${MAX_HOSTNAME_LENGTH} characters`)];
  }
  const issues = labelIssues("tld", value);
  if (issues.length > 0) return issues;
  const last = value.split(".").at(-1) ?? "";
  // An all-numeric last label makes the hostname ambiguous with an IP address.
  if (/^[0-9]+$/.test(last)) return [issue("tld", "must not be numeric")];
  return [];
}

/**
 * Throws `ValidationError` with every issue found. `excludeId` skips the alias
 * being updated so it does not collide with itself.
 */
export function assertValidAlias(
  input: CreateAliasInput,
  existing: Alias[],
  opts?: { excludeId?: string },
): void {
  const issues: ValidationIssue[] = [];
  const name = normalizeName(input?.name ?? "");

  issues.push(...validateName(input?.name ?? ""));
  issues.push(...validatePort(input?.port));
  if (input?.target !== undefined && input.target !== null) {
    issues.push(...validateTarget(input.target));
  }

  if (name.length > 0) {
    const taken = (existing ?? []).some(
      (alias) => alias.id !== opts?.excludeId && normalizeName(alias.name) === name,
    );
    if (taken) issues.push(issue("name", `"${name}" is already used by another alias`));
  }

  if (issues.length > 0) throw new ValidationError(issues);
}

/** "myapp" + "local" -> "myapp.local". */
export function hostnameFor(name: string, tld: string): string {
  const label = normalizeName(name);
  const suffix = normalizeTld(tld);
  return suffix.length > 0 ? `${label}.${suffix}` : label;
}

/** `port` is the listener port; it is omitted when it is the scheme default. */
export function urlFor(name: string, tld: string, https: boolean, port: number): string {
  const scheme = https ? "https" : "http";
  const host = hostnameFor(name, tld);
  const isDefaultPort = port === (https ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);
  return isDefaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}
