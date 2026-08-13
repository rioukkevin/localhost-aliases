/**
 * Hostname and alias validation. Pure; no I/O.
 *
 * An alias `name` may itself contain dots (`api.myapp`), so it is validated as a
 * sequence of DNS labels rather than a single label.
 */
import {
  RESERVED_ALIAS_NAME,
  RESERVED_NAMES,
  ValidationError,
  type Alias,
  type CreateAliasInput,
  type UpdateAliasInput,
  type ValidationIssue,
} from "./types.ts";

export const MAX_LABEL_LENGTH = 63;
export const MAX_HOSTNAME_LENGTH = 253;

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function isValidLabel(label: string): boolean {
  return label.length >= 1 && label.length <= MAX_LABEL_LENGTH && LABEL_RE.test(label);
}

/** A dot-separated sequence of DNS labels. Used for both alias names and the TLD. */
export function isValidName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;
  return name.split(".").every(isValidLabel);
}

export const isValidTld = isValidName;

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** What the UI should do to raw user input before validating it. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function hostnameFor(name: string, tld: string): string {
  return `${name}.${tld}`;
}

/** Project aliases are raw TCP forwards on port 80: v2 can never make them https. */
export function urlFor(name: string, tld: string): string {
  return `http://${hostnameFor(name, tld)}`;
}

export interface ValidateAliasOptions {
  /** Id of the alias being updated; it is skipped by the uniqueness check. */
  excludeId?: string;
  /** Permit the reserved `index` name. Only the store's seeding path sets this. */
  allowReserved?: boolean;
  /** Only validate the fields that are present. Used for updates. */
  partial?: boolean;
  /** TLD the name will be joined with, so the full hostname length can be checked. */
  tld?: string;
}

function nameIssues(raw: unknown, opts: ValidateAliasOptions, existing: readonly Alias[]): ValidationIssue[] {
  const field = "name";
  if (typeof raw !== "string" || raw.trim() === "") {
    return [{ field, message: "A name is required." }];
  }
  const name = raw.trim();
  if (name !== name.toLowerCase()) {
    return [{ field, message: "Use lowercase letters only." }];
  }
  if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) {
    return [{ field, message: "Dots must separate parts, e.g. api.myapp." }];
  }
  const labels = name.split(".");
  for (const label of labels) {
    if (label.length > MAX_LABEL_LENGTH) {
      return [{ field, message: `Each part must be ${MAX_LABEL_LENGTH} characters or fewer.` }];
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return [{ field, message: "Parts cannot start or end with a hyphen." }];
    }
    if (!isValidLabel(label)) {
      return [{ field, message: "Use letters, digits and hyphens only." }];
    }
  }
  const tld = opts.tld;
  if (tld && hostnameFor(name, tld).length > MAX_HOSTNAME_LENGTH) {
    return [{ field, message: `The full hostname must be ${MAX_HOSTNAME_LENGTH} characters or fewer.` }];
  }
  if ((RESERVED_NAMES as readonly string[]).includes(name)) {
    return [{ field, message: `"${name}" is reserved by macOS and cannot be used.` }];
  }
  if (name === RESERVED_ALIAS_NAME && !opts.allowReserved) {
    return [{ field, message: `"${RESERVED_ALIAS_NAME}" is reserved for the dashboard.` }];
  }
  const clash = existing.find(
    (a) => a.id !== opts.excludeId && a.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    return [{ field, message: `"${name}" already exists.` }];
  }
  return [];
}

function portIssues(raw: unknown): ValidationIssue[] {
  const field = "port";
  if (raw === undefined || raw === null || raw === "") {
    return [{ field, message: "A port is required." }];
  }
  if (!isValidPort(raw)) {
    return [{ field, message: "Port must be a whole number between 1 and 65535." }];
  }
  return [];
}

/** Throws ValidationError listing every problem at once, so a form can show them all. */
export function assertValidAlias(
  input: CreateAliasInput | UpdateAliasInput,
  existing: readonly Alias[] = [],
  opts: ValidateAliasOptions = {},
): void {
  const issues: ValidationIssue[] = [];
  const partial = opts.partial === true;

  if (!partial || input.name !== undefined) issues.push(...nameIssues(input.name, opts, existing));
  if (!partial || input.port !== undefined) issues.push(...portIssues(input.port));

  if (input.projectPath !== undefined && input.projectPath !== null) {
    if (typeof input.projectPath !== "string" || input.projectPath.trim() === "") {
      issues.push({ field: "projectPath", message: "Project path must be a non-empty path." });
    } else if (!input.projectPath.startsWith("/")) {
      issues.push({ field: "projectPath", message: "Project path must be absolute." });
    }
  }
  if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
    issues.push({ field: "description", message: "Description must be text." });
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    issues.push({ field: "enabled", message: "Enabled must be true or false." });
  }

  if (issues.length > 0) throw new ValidationError(issues);
}

export function assertValidTld(tld: unknown): void {
  if (typeof tld !== "string" || !isValidTld(tld.trim().toLowerCase())) {
    throw new ValidationError([
      { field: "tld", message: "TLD must be lowercase letters, digits or hyphens, e.g. local." },
    ]);
  }
  // "local" is the default TLD, so RESERVED_NAMES does not apply here; only localhost is fatal,
  // since anything.localhost is resolved by the OS and would never reach our hosts entry.
  if (tld.trim().toLowerCase() === "localhost") {
    throw new ValidationError([{ field: "tld", message: '"localhost" cannot be used as a TLD.' }]);
  }
}

export function assertValidPort(port: unknown, field = "port"): void {
  if (!isValidPort(port)) {
    throw new ValidationError([
      { field, message: "Port must be a whole number between 1 and 65535." },
    ]);
  }
}
