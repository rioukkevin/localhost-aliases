/**
 * The persisted `Config` at `configPath()`.
 *
 * Three guarantees:
 *  - writes are atomic (temp file in the same directory + rename)
 *  - a corrupt or unexpected file is backed up and replaced instead of crashing
 *  - every mutation runs inside `withConfigLock`, so concurrent API calls queue
 *    up instead of interleaving read-modify-write cycles and losing entries.
 */
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";
import {
  DEFAULT_CONFIG,
  ValidationError,
  type Alias,
  type Config,
  type CreateAliasInput,
  type UpdateAliasInput,
  type ValidationIssue,
} from "./types.ts";
import {
  DEFAULT_TARGET,
  assertValidAlias,
  normalizeName,
  normalizeTld,
  validateName,
  validatePort,
  validateTarget,
  validateTld,
} from "./validation.ts";

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serializes all mutations; exported for tests.
 * Not reentrant: never call it from inside another `withConfigLock` callback.
 */
export function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  // `then(fn, fn)` so a rejected predecessor never blocks the queue forever.
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Disk IO
// ---------------------------------------------------------------------------

function seed(): Config {
  return { ...DEFAULT_CONFIG, aliases: [] };
}

/** Atomic: rename(2) inside one directory is atomic, so readers see old or new. */
async function writeConfig(config: Config): Promise<Config> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await Bun.write(tmp, `${JSON.stringify(config, null, 2)}\n`);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  return config;
}

/** Keeps the unreadable file around for the user instead of deleting it. */
async function backupBrokenConfig(): Promise<void> {
  const path = configPath();
  try {
    await Bun.write(`${path}.bak`, Bun.file(path));
  } catch {
    // A backup failure must never prevent recovery.
  }
}

/** Seeds defaults if missing; recovers by backing up anything unreadable. */
export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return await writeConfig(seed());

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    await backupBrokenConfig();
    return await writeConfig(seed());
  }

  const migrated = migrateConfig(raw);
  if (migrated === null) {
    await backupBrokenConfig();
    return await writeConfig(seed());
  }
  return migrated;
}

/** Atomic write. Does not take the lock — mutations already hold it. */
export async function saveConfig(config: Config): Promise<Config> {
  return await writeConfig(config);
}

// ---------------------------------------------------------------------------
// Defensive migration
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portOr(value: unknown, fallback: number): number {
  return validatePort(value).length === 0 ? (value as number) : fallback;
}

function isoOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return Number.isNaN(Date.parse(value)) ? fallback : value;
}

/** Returns null when the shape is unusable and the file should be replaced. */
function migrateConfig(raw: unknown): Config | null {
  if (!isRecord(raw)) return null;
  if (raw.aliases !== undefined && !Array.isArray(raw.aliases)) return null;

  const seen = new Set<string>();
  const aliases: Alias[] = [];
  for (const entry of (raw.aliases ?? []) as unknown[]) {
    const alias = migrateAlias(entry);
    if (alias === null || seen.has(alias.name)) continue;
    seen.add(alias.name);
    aliases.push(alias);
  }

  const tld = typeof raw.tld === "string" && validateTld(raw.tld).length === 0
    ? normalizeTld(raw.tld)
    : DEFAULT_CONFIG.tld;

  return {
    version: 1,
    tld,
    httpPort: portOr(raw.httpPort, DEFAULT_CONFIG.httpPort),
    httpsPort: portOr(raw.httpsPort, DEFAULT_CONFIG.httpsPort),
    dashboardPort: portOr(raw.dashboardPort, DEFAULT_CONFIG.dashboardPort),
    https: typeof raw.https === "boolean" ? raw.https : DEFAULT_CONFIG.https,
    aliases,
  };
}

/** Drops entries we cannot make sense of; fills in everything else. */
function migrateAlias(entry: unknown): Alias | null {
  if (!isRecord(entry)) return null;
  const name = normalizeName(typeof entry.name === "string" ? entry.name : "");
  if (validateName(name).length > 0) return null;
  if (validatePort(entry.port).length > 0) return null;

  const now = new Date().toISOString();
  const target = typeof entry.target === "string" && validateTarget(entry.target).length === 0
    ? entry.target.trim().toLowerCase()
    : DEFAULT_TARGET;

  return {
    id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : crypto.randomUUID(),
    name,
    port: entry.port as number,
    target,
    projectPath: typeof entry.projectPath === "string" ? entry.projectPath : null,
    description: typeof entry.description === "string" ? entry.description : null,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    createdAt: isoOr(entry.createdAt, now),
    updatedAt: isoOr(entry.updatedAt, now),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listAliases(): Promise<Alias[]> {
  const config = await loadConfig();
  return config.aliases;
}

/** Accepts an alias id or a bare name ("myapp"), case-insensitive. */
export async function getAlias(idOrName: string): Promise<Alias | null> {
  const config = await loadConfig();
  const byId = config.aliases.find((alias) => alias.id === idOrName);
  if (byId) return byId;
  const name = normalizeName(idOrName ?? "");
  if (name.length === 0) return null;
  return config.aliases.find((alias) => alias.name === name) ?? null;
}

function notFound(id: string): Error {
  return new Error(`Alias not found: ${id}`);
}

export async function createAlias(
  input: CreateAliasInput,
): Promise<{ config: Config; alias: Alias }> {
  return withConfigLock(async () => {
    const config = await loadConfig();
    assertValidAlias(input, config.aliases);

    const now = new Date().toISOString();
    const alias: Alias = {
      id: crypto.randomUUID(),
      name: normalizeName(input.name),
      port: input.port,
      target: (input.target ?? DEFAULT_TARGET).trim().toLowerCase(),
      projectPath: input.projectPath ?? null,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    const next = await writeConfig({ ...config, aliases: [...config.aliases, alias] });
    return { config: next, alias };
  });
}

export async function updateAlias(
  id: string,
  input: UpdateAliasInput,
): Promise<{ config: Config; alias: Alias }> {
  return withConfigLock(async () => {
    const config = await loadConfig();
    const current = config.aliases.find((alias) => alias.id === id);
    if (!current) throw notFound(id);

    const candidate: CreateAliasInput = {
      name: input.name ?? current.name,
      port: input.port ?? current.port,
      target: input.target ?? current.target,
    };
    assertValidAlias(candidate, config.aliases, { excludeId: id });

    const alias: Alias = {
      ...current,
      name: normalizeName(candidate.name),
      port: candidate.port,
      target: (candidate.target ?? DEFAULT_TARGET).trim().toLowerCase(),
      projectPath: input.projectPath !== undefined ? input.projectPath : current.projectPath,
      description: input.description !== undefined ? input.description : current.description,
      enabled: input.enabled !== undefined ? input.enabled : current.enabled,
      updatedAt: new Date().toISOString(),
    };

    const next = await writeConfig({
      ...config,
      aliases: config.aliases.map((entry) => (entry.id === id ? alias : entry)),
    });
    return { config: next, alias };
  });
}

export async function deleteAlias(id: string): Promise<{ config: Config; alias: Alias }> {
  return withConfigLock(async () => {
    const config = await loadConfig();
    const alias = config.aliases.find((entry) => entry.id === id);
    if (!alias) throw notFound(id);

    const next = await writeConfig({
      ...config,
      aliases: config.aliases.filter((entry) => entry.id !== id),
    });
    return { config: next, alias };
  });
}

export async function updateSettings(
  patch: Partial<Omit<Config, "aliases" | "version">>,
): Promise<Config> {
  return withConfigLock(async () => {
    const config = await loadConfig();
    const issues: ValidationIssue[] = [];
    const next: Config = { ...config };

    if (patch.tld !== undefined) {
      issues.push(...validateTld(patch.tld));
      next.tld = normalizeTld(patch.tld);
    }
    for (const key of ["httpPort", "httpsPort", "dashboardPort"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      issues.push(...validatePort(value).map((entry) => ({ ...entry, field: key })));
      next[key] = value;
    }
    if (patch.https !== undefined) {
      if (typeof patch.https !== "boolean") {
        issues.push({ field: "https", message: "must be a boolean" });
      }
      next.https = patch.https;
    }

    if (issues.length > 0) throw new ValidationError(issues);
    return await writeConfig(next);
  });
}
