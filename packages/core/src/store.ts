/**
 * The JSON config store at configPath().
 *
 * Everything that mutates goes through one in-process mutex and one atomic write, so
 * the dashboard's API routes cannot interleave and lose an alias. A corrupt file is
 * moved aside rather than thrown at the user: the app must always start.
 */
import { configPath } from "./paths.ts";
import {
  DEFAULT_CONFIG,
  RESERVED_ALIAS_NAME,
  ValidationError,
  type Alias,
  type Config,
  type CreateAliasInput,
  type UpdateAliasInput,
} from "./types.ts";
import { allocateIp, isValidIpv4 } from "./ips.ts";
import { blockedTldReason } from "./tld.ts";
import { assertValidAlias, assertValidPort, assertValidTld, isValidPort, isValidTld, normalizeName } from "./validation.ts";
import { backupFile, readFileOrNull, writeFileAtomic } from "./atomic.ts";

// --- mutex ------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/** Serialises every read-or-write of the config within this process. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- shape ------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function reservedAlias(ip: string, port: number): Alias {
  const ts = nowIso();
  return {
    id: crypto.randomUUID(),
    name: RESERVED_ALIAS_NAME,
    port,
    ip,
    projectPath: null,
    description: "The Localhost Aliases dashboard.",
    enabled: true,
    reserved: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

function isAliasish(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coerceAlias(raw: Record<string, unknown>, taken: Set<string>): Alias | null {
  const name = typeof raw.name === "string" ? normalizeName(raw.name) : "";
  if (name === "") return null;
  const port = typeof raw.port === "number" ? raw.port : Number(raw.port);
  if (!isValidPort(port)) return null;
  const ip = typeof raw.ip === "string" && isValidIpv4(raw.ip) && !taken.has(raw.ip) ? raw.ip : allocateIp(taken);
  taken.add(ip);
  const ts = nowIso();
  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : crypto.randomUUID(),
    name,
    port,
    ip,
    projectPath: typeof raw.projectPath === "string" ? raw.projectPath : null,
    description: typeof raw.description === "string" ? raw.description : null,
    enabled: raw.enabled !== false,
    reserved: raw.reserved === true || name === RESERVED_ALIAS_NAME,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : ts,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : ts,
  };
}

/**
 * A config written before a suffix was blocked may still name it — the developer's own
 * machine says "local". There is no migration flow by design: the value is replaced by the
 * default, said once in the log, and written straight back, so the very next reconcile
 * rewrites /etc/hosts through the normal apply path. Aliases are untouched: only the suffix
 * changes, every name, IP and port survives.
 */
function coerceTld(raw: unknown): string {
  if (typeof raw !== "string" || !isValidTld(raw)) return DEFAULT_CONFIG.tld;
  const blocked = blockedTldReason(raw);
  if (!blocked) return raw;
  console.warn(
    `[localhost-aliases] TLD ".${raw}" is no longer supported, falling back to ".${DEFAULT_CONFIG.tld}". ${blocked}`,
  );
  return DEFAULT_CONFIG.tld;
}

/**
 * Bring any parsed JSON up to the current contract. Returns the config plus whether
 * anything had to change, so a repaired file is written back once.
 */
function normalizeConfig(parsed: unknown): { config: Config; changed: boolean } {
  const raw = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  let changed = false;

  const tld = coerceTld(raw.tld);
  if (tld !== raw.tld) changed = true;
  const dashboardPort = isValidPort(raw.dashboardPort) ? raw.dashboardPort : DEFAULT_CONFIG.dashboardPort;
  if (dashboardPort !== raw.dashboardPort) changed = true;
  const https = typeof raw.https === "boolean" ? raw.https : DEFAULT_CONFIG.https;
  if (https !== raw.https) changed = true;
  // A config written before autoApply existed has no such field, and a MISSING field is
  // not `false`: only an explicit `false` turns automatic apply off. Anything else, including
  // a non-boolean somebody hand-edited in, reads as the default (true).
  const autoApply = typeof raw.autoApply === "boolean" ? raw.autoApply : DEFAULT_CONFIG.autoApply;
  if (autoApply !== raw.autoApply) changed = true;
  if (raw.version !== 2) changed = true;

  const taken = new Set<string>();
  const aliases: Alias[] = [];
  const rawAliases = Array.isArray(raw.aliases) ? raw.aliases : [];
  if (!Array.isArray(raw.aliases)) changed = true;

  for (const entry of rawAliases) {
    if (!isAliasish(entry)) {
      changed = true;
      continue;
    }
    const alias = coerceAlias(entry, taken);
    if (!alias) {
      changed = true;
      continue;
    }
    if (alias.ip !== entry.ip || alias.name !== entry.name || alias.id !== entry.id) changed = true;
    if (aliases.some((a) => a.name === alias.name)) {
      changed = true;
      continue;
    }
    aliases.push(alias);
  }

  const reservedIdx = aliases.findIndex((a) => a.name === RESERVED_ALIAS_NAME);
  if (reservedIdx === -1) {
    // The dashboard alias always exists and always holds the first free address.
    aliases.unshift(reservedAlias(allocateIp(taken), dashboardPort));
    changed = true;
  } else {
    const reserved = aliases[reservedIdx]!;
    if (!reserved.reserved || !reserved.enabled || reserved.port !== dashboardPort) {
      aliases[reservedIdx] = { ...reserved, reserved: true, enabled: true, port: dashboardPort };
      changed = true;
    }
  }

  return { config: { version: 2, tld, dashboardPort, https, autoApply, aliases }, changed };
}

// --- io ---------------------------------------------------------------------

async function readUnlocked(): Promise<Config> {
  const path = configPath();
  const text = await readFileOrNull(path);

  if (text === null) {
    const { config } = normalizeConfig({ ...DEFAULT_CONFIG, aliases: [] });
    await writeFileAtomic(path, serialize(config));
    return config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    await backupFile(path, "corrupt");
    const { config } = normalizeConfig({ ...DEFAULT_CONFIG, aliases: [] });
    await writeFileAtomic(path, serialize(config));
    return config;
  }

  const { config, changed } = normalizeConfig(parsed);
  if (changed) await writeFileAtomic(path, serialize(config));
  return config;
}

function serialize(config: Config): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function writeUnlocked(config: Config): Promise<void> {
  await writeFileAtomic(configPath(), serialize(config));
}

/** Load the config, seeding or repairing the file if needed. */
export function loadConfig(): Promise<Config> {
  return withLock(readUnlocked);
}

/** Read-modify-write under the mutex. */
async function mutate<T>(fn: (config: Config) => Promise<T> | T): Promise<T> {
  return withLock(async () => {
    const config = await readUnlocked();
    const result = await fn(config);
    await writeUnlocked(config);
    return result;
  });
}

// --- CRUD -------------------------------------------------------------------

export async function listAliases(): Promise<Alias[]> {
  return (await loadConfig()).aliases;
}

export async function getAlias(id: string): Promise<Alias | null> {
  return (await loadConfig()).aliases.find((a) => a.id === id) ?? null;
}

export async function getAliasByName(name: string): Promise<Alias | null> {
  const wanted = normalizeName(name);
  return (await loadConfig()).aliases.find((a) => a.name === wanted) ?? null;
}

export async function createAlias(input: CreateAliasInput): Promise<Alias> {
  return mutate((config) => {
    const name = typeof input.name === "string" ? normalizeName(input.name) : input.name;
    assertValidAlias({ ...input, name }, config.aliases, { tld: config.tld });

    const ts = nowIso();
    const alias: Alias = {
      id: crypto.randomUUID(),
      name: name as string,
      port: input.port,
      ip: allocateIp(config.aliases.map((a) => a.ip)),
      projectPath: input.projectPath ?? null,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      reserved: false,
      createdAt: ts,
      updatedAt: ts,
    };
    config.aliases.push(alias);
    return alias;
  });
}

export async function updateAlias(id: string, input: UpdateAliasInput): Promise<Alias> {
  return mutate((config) => {
    const index = config.aliases.findIndex((a) => a.id === id);
    const current = config.aliases[index];
    if (index === -1 || !current) {
      throw new ValidationError([{ field: "id", message: `No alias with id "${id}".` }]);
    }

    const name = typeof input.name === "string" ? normalizeName(input.name) : undefined;
    if (current.reserved) {
      if (name !== undefined && name !== current.name) {
        throw new ValidationError([
          { field: "name", message: "The dashboard alias cannot be renamed." },
        ]);
      }
      if (input.enabled === false) {
        throw new ValidationError([
          { field: "enabled", message: "The dashboard alias cannot be disabled." },
        ]);
      }
    }

    assertValidAlias({ ...input, ...(name !== undefined ? { name } : {}) }, config.aliases, {
      excludeId: id,
      partial: true,
      allowReserved: current.reserved,
      tld: config.tld,
    });

    const next: Alias = {
      ...current,
      ...(name !== undefined ? { name } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.projectPath !== undefined ? { projectPath: input.projectPath ?? null } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: nowIso(),
    };
    // The dashboard alias's port is a mirror of dashboardPort, never edited on its own.
    if (current.reserved) next.port = config.dashboardPort;
    config.aliases[index] = next;
    return next;
  });
}

export async function deleteAlias(id: string): Promise<void> {
  return mutate((config) => {
    const alias = config.aliases.find((a) => a.id === id);
    if (!alias) throw new ValidationError([{ field: "id", message: `No alias with id "${id}".` }]);
    if (alias.reserved) {
      throw new ValidationError([
        { field: "id", message: "The dashboard alias cannot be deleted." },
      ]);
    }
    config.aliases = config.aliases.filter((a) => a.id !== id);
  });
}

export type SettingsPatch = Partial<Pick<Config, "tld" | "dashboardPort" | "https" | "autoApply">>;

export async function updateSettings(patch: SettingsPatch): Promise<Config> {
  return mutate((config) => {
    if (patch.tld !== undefined) {
      assertValidTld(patch.tld);
      config.tld = patch.tld.trim().toLowerCase();
    }
    if (patch.dashboardPort !== undefined) {
      assertValidPort(patch.dashboardPort, "dashboardPort");
      config.dashboardPort = patch.dashboardPort;
    }
    if (patch.https !== undefined) {
      if (typeof patch.https !== "boolean") {
        throw new ValidationError([{ field: "https", message: "https must be true or false." }]);
      }
      config.https = patch.https;
    }
    if (patch.autoApply !== undefined) {
      if (typeof patch.autoApply !== "boolean") {
        throw new ValidationError([{ field: "autoApply", message: "autoApply must be true or false." }]);
      }
      config.autoApply = patch.autoApply;
    }
    const reserved = config.aliases.find((a) => a.reserved);
    if (reserved) reserved.port = config.dashboardPort;
    return config;
  });
}
