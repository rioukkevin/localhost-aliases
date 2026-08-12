/**
 * Wire-level input parsing. Nothing here trusts the client: unknown fields are
 * rejected outright (a typo'd key must not silently do nothing), strings are
 * trimmed, and ports arriving as strings — every HTML form sends them that way —
 * are coerced explicitly rather than by `Number()` coincidence.
 *
 * Domain rules (reserved names, uniqueness, loopback targets) stay in core; this
 * file only guarantees core receives well-shaped values.
 */
import {
  ValidationError,
  validateName,
  validatePort,
  type CreateAliasInput,
  type McpClientId,
  type UpdateAliasInput,
  type ValidationIssue,
  type WorkspaceAliasEntry,
} from "@localhost-aliases/core";

type Body = Record<string, unknown>;

function fail(field: string, message: string): never {
  throw new ValidationError([{ field, message }]);
}

/** Reads and parses the JSON body; an empty body is treated as `{}`. */
export async function readJsonBody(req: Request): Promise<Body> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    fail("body", "could not be read");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("body", "must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("body", "must be a JSON object");
  }
  return parsed as Body;
}

function unknownFieldIssues(body: Body, allowed: readonly string[], prefix = ""): ValidationIssue[] {
  return Object.keys(body)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ field: `${prefix}${key}`, message: "is not a recognized field" }));
}

function assertNoUnknownFields(body: Body, allowed: readonly string[], prefix = ""): void {
  const issues = unknownFieldIssues(body, allowed, prefix);
  if (issues.length > 0) throw new ValidationError(issues);
}

/** Accepts 3000 and "3000"; rejects "3000abc", "3e3", 3000.5, "" and booleans. */
export function coercePort(value: unknown, field = "port"): number | ValidationIssue {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : { field, message: "must be an integer" };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return { field, message: "must be a whole number" };
    return Number(trimmed);
  }
  return { field, message: "must be a number" };
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(field, "must be a string or null");
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const ALIAS_FIELDS = ["name", "port", "target", "projectPath", "description", "enabled"] as const;

export function parseCreateAlias(body: Body): CreateAliasInput {
  assertNoUnknownFields(body, ALIAS_FIELDS);
  const issues: ValidationIssue[] = [];

  if (typeof body.name !== "string") issues.push({ field: "name", message: "is required" });
  const port = coercePort(body.port);
  if (typeof port !== "number") issues.push(port);
  if (body.target !== undefined && typeof body.target !== "string") {
    issues.push({ field: "target", message: "must be a string" });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    issues.push({ field: "enabled", message: "must be a boolean" });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  const input: CreateAliasInput = { name: body.name as string, port: port as number };
  if (body.target !== undefined) input.target = (body.target as string).trim();
  if (body.projectPath !== undefined) {
    input.projectPath = stringOrNull(body.projectPath, "projectPath");
  }
  if (body.description !== undefined) {
    input.description = stringOrNull(body.description, "description");
  }
  if (body.enabled !== undefined) input.enabled = body.enabled as boolean;
  return input;
}

export function parseUpdateAlias(body: Body): UpdateAliasInput {
  assertNoUnknownFields(body, ALIAS_FIELDS);
  const issues: ValidationIssue[] = [];
  const input: UpdateAliasInput = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") issues.push({ field: "name", message: "must be a string" });
    else input.name = body.name;
  }
  if (body.port !== undefined) {
    const port = coercePort(body.port);
    if (typeof port === "number") input.port = port;
    else issues.push(port);
  }
  if (body.target !== undefined) {
    if (typeof body.target !== "string") {
      issues.push({ field: "target", message: "must be a string" });
    } else input.target = body.target.trim();
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      issues.push({ field: "enabled", message: "must be a boolean" });
    } else input.enabled = body.enabled;
  }
  if (issues.length > 0) throw new ValidationError(issues);

  // Explicit `null` is meaningful here (detach the alias from its project).
  if (body.projectPath !== undefined) input.projectPath = stringOrNull(body.projectPath, "projectPath");
  if (body.description !== undefined) input.description = stringOrNull(body.description, "description");
  return input;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsPatch {
  tld?: string;
  httpPort?: number;
  httpsPort?: number;
  dashboardPort?: number;
  https?: boolean;
}

const SETTINGS_PORTS = ["httpPort", "httpsPort", "dashboardPort"] as const;
const SETTINGS_FIELDS = ["tld", ...SETTINGS_PORTS, "https"] as const;

export function parseSettingsPatch(body: Body): SettingsPatch {
  assertNoUnknownFields(body, SETTINGS_FIELDS);
  const issues: ValidationIssue[] = [];
  const patch: SettingsPatch = {};

  if (body.tld !== undefined) {
    if (typeof body.tld !== "string") issues.push({ field: "tld", message: "must be a string" });
    else patch.tld = body.tld;
  }
  for (const key of SETTINGS_PORTS) {
    if (body[key] === undefined) continue;
    const port = coercePort(body[key], key);
    if (typeof port === "number") patch[key] = port;
    else issues.push(port);
  }
  if (body.https !== undefined) {
    if (typeof body.https !== "boolean") issues.push({ field: "https", message: "must be a boolean" });
    else patch.https = body.https;
  }

  if (issues.length > 0) throw new ValidationError(issues);
  if (Object.keys(patch).length === 0) fail("body", "must contain at least one setting to update");
  return patch;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface LinkProjectInput {
  path: string;
  aliases: WorkspaceAliasEntry[];
}

const LINK_FIELDS = ["path", "aliases"] as const;
const ENTRY_FIELDS = ["name", "port", "description"] as const;

/**
 * Every entry is validated before anything is written, so a bad third entry
 * cannot leave the first two half-registered.
 */
export function parseLinkProject(body: Body): LinkProjectInput {
  assertNoUnknownFields(body, LINK_FIELDS);
  const issues: ValidationIssue[] = [];

  if (typeof body.path !== "string" || body.path.trim() === "") {
    issues.push({ field: "path", message: "is required" });
  }
  if (!Array.isArray(body.aliases)) {
    issues.push({ field: "aliases", message: "must be an array" });
    throw new ValidationError(issues);
  }

  const entries: WorkspaceAliasEntry[] = [];
  const seen = new Set<string>();
  body.aliases.forEach((raw: unknown, index: number) => {
    const field = (key: string) => `aliases[${index}].${key}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ field: `aliases[${index}]`, message: "must be an object" });
      return;
    }
    const entry = raw as Body;
    issues.push(...unknownFieldIssues(entry, ENTRY_FIELDS, `aliases[${index}].`));

    const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
    issues.push(...validateName(name).map((i) => ({ ...i, field: field("name") })));
    if (name !== "" && seen.has(name)) {
      issues.push({ field: field("name"), message: `"${name}" appears twice in this request` });
    }
    seen.add(name);

    const port = coercePort(entry.port, field("port"));
    if (typeof port !== "number") {
      issues.push(port);
    } else {
      issues.push(...validatePort(port).map((i) => ({ ...i, field: field("port") })));
    }
    if (entry.description !== undefined && entry.description !== null) {
      if (typeof entry.description !== "string") {
        issues.push({ field: field("description"), message: "must be a string" });
      }
    }

    if (typeof port === "number") {
      const description =
        typeof entry.description === "string" && entry.description.trim() !== ""
          ? entry.description.trim()
          : undefined;
      entries.push({ name, port, ...(description ? { description } : {}) });
    }
  });

  if (issues.length > 0) throw new ValidationError(issues);
  return { path: (body.path as string).trim(), aliases: entries };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export function parseMcpInstall(body: Body): McpClientId {
  assertNoUnknownFields(body, ["client"]);
  if (body.client !== "claude" && body.client !== "codex") {
    fail("client", 'must be "claude" or "codex"');
  }
  return body.client;
}
