/**
 * Stack detection: given a project folder, name the framework and the command that starts it
 * ON A GIVEN PORT. The offline page and the project card show it; nothing here ever runs it.
 *
 * Rules that shape every decision below:
 * - READ ONLY. We open package.json, lockfile names, a Gemfile, a manage.py. We never execute
 *   anything and never write a byte into the user's repository.
 * - The command must PIN THE PORT, because the whole product is "this hostname maps to that
 *   port". A command that starts the server on its own default port is worse than no command.
 * - We never guess. An unrecognised folder returns null and the UI says plainly that it does
 *   not know, which is honest and costs the user nothing.
 * - Nothing throws. A missing, unreadable or malformed package.json is a normal shape in the
 *   wild; it just means the JavaScript evidence is unavailable, so we fall through to the
 *   non-JS markers and, failing those, to null.
 *
 * Evidence, in the order we trust it:
 *  1. the dev/start scripts — what the project actually runs;
 *  2. direct dependencies of package.json;
 *  3. workspace delegation, for a monorepo root that only forwards to a child package;
 *  4. non-JS markers (bin/rails, manage.py, artisan) and finally a plain index.html.
 *
 * Lockfiles are read for their NAME only, to learn the package manager. We deliberately do not
 * mine them for framework names: a lockfile lists the whole tree, so a Next app that pulled in
 * vite transitively would look like a Vite app. Direct evidence beats the tree, always.
 */
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileExists, readFileOrNull } from "./atomic.ts";
import { isValidPort } from "./validation.ts";

export interface DetectedStack {
  /** Display name, e.g. "Next.js". */
  framework: string;
  /** Concrete command that starts this project on the requested port. */
  command: string;
  /** "high" when the project's own scripts or a framework marker said so. */
  confidence: "high" | "low";
}

/** Used when the caller does not say which port the alias points at. */
export const DEFAULT_STACK_PORT = 3000;

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** Lockfile name -> package manager. Order matters: the first present wins. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Scripts we look at first, because they are the ones a human runs to develop. */
const SCRIPT_PRIORITY = ["dev", "develop", "start", "serve", "start:dev", "dev:server"];

/** How many sibling packages of a monorepo we are willing to open. Bounded on purpose. */
const MAX_WORKSPACE_CANDIDATES = 48;

// ---------------------------------------------------------------------------
// package.json, defensively
// ---------------------------------------------------------------------------

interface PackageJson {
  deps: Set<string>;
  scripts: Array<{ name: string; command: string }>;
  workspaces: string[];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parsePackageJson(text: string): PackageJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // Malformed is not an error here, just an absence of evidence.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const deps = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block = raw[field];
    if (typeof block === "object" && block !== null && !Array.isArray(block)) {
      for (const name of Object.keys(block)) deps.add(name);
    }
  }

  const scripts: Array<{ name: string; command: string }> = [];
  const rawScripts = raw.scripts;
  if (typeof rawScripts === "object" && rawScripts !== null && !Array.isArray(rawScripts)) {
    for (const [name, command] of Object.entries(rawScripts)) {
      if (typeof command === "string") scripts.push({ name, command });
    }
  }
  scripts.sort((a, b) => scriptRank(a.name) - scriptRank(b.name));

  const rawWorkspaces = raw.workspaces;
  const workspaces =
    typeof rawWorkspaces === "object" && rawWorkspaces !== null && !Array.isArray(rawWorkspaces)
      ? toStringArray((rawWorkspaces as Record<string, unknown>).packages)
      : toStringArray(rawWorkspaces);

  return { deps, scripts, workspaces };
}

function scriptRank(name: string): number {
  const index = SCRIPT_PRIORITY.indexOf(name);
  return index === -1 ? SCRIPT_PRIORITY.length : index;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const text = await readFileOrNull(join(dir, "package.json"));
  return text === null ? null : parsePackageJson(text);
}

async function detectPackageManager(dir: string): Promise<PackageManager | null> {
  for (const [file, pm] of LOCKFILES) {
    if (await fileExists(join(dir, file))) return pm;
  }
  return null;
}

/** How to run a one-off CLI with the project's own package manager. */
function runner(pm: PackageManager | null): string {
  switch (pm) {
    case "bun":
      return "bunx";
    case "pnpm":
      return "pnpm dlx";
    case "yarn":
      return "yarn dlx";
    default:
      return "npx";
  }
}

// ---------------------------------------------------------------------------
// The framework table
// ---------------------------------------------------------------------------

interface CommandContext {
  port: number;
  pm: PackageManager | null;
  deps: Set<string>;
  /** The script text that matched, when the match came from a script. */
  script: string | null;
}

interface Framework {
  name: string;
  /** Direct dependencies that name this framework. */
  deps: readonly string[];
  /** Tokens as they appear inside a script command. */
  scripts: readonly RegExp[];
  /**
   * True when the script tokens are too generic to stand alone — SvelteKit runs plain
   * `vite dev`, so it may only claim that script when @sveltejs/kit is actually a dependency.
   */
  scriptNeedsDep?: boolean;
  command: (ctx: CommandContext) => string;
}

/** Ordered most specific first. Only used to break ties when scripts say nothing. */
const FRAMEWORKS: readonly Framework[] = [
  {
    name: "Next.js",
    deps: ["next"],
    scripts: [/\bnext\s+dev\b/],
    command: ({ port }) => `next dev -p ${port}`,
  },
  {
    name: "Nuxt",
    deps: ["nuxt", "nuxt3", "nuxi"],
    scripts: [/\bnuxt\s+dev\b/, /\bnuxi\s+dev\b/],
    command: ({ port }) => `nuxt dev --port ${port}`,
  },
  {
    name: "Remix",
    deps: ["@remix-run/dev", "@remix-run/serve", "@remix-run/react"],
    scripts: [/\bremix\s+vite:dev\b/, /\bremix\s+dev\b/],
    command: ({ port, deps, script }) =>
      script?.includes("vite:dev") || deps.has("vite")
        ? `remix vite:dev --port ${port}`
        : `remix dev --port ${port}`,
  },
  {
    name: "SvelteKit",
    deps: ["@sveltejs/kit"],
    scripts: [/\bsvelte-kit\s+dev\b/, /\bvite\b/],
    scriptNeedsDep: true,
    command: ({ port }) => `vite dev --port ${port}`,
  },
  {
    name: "Astro",
    deps: ["astro"],
    scripts: [/\bastro\s+dev\b/],
    command: ({ port }) => `astro dev --port ${port}`,
  },
  {
    name: "Gatsby",
    deps: ["gatsby"],
    scripts: [/\bgatsby\s+develop\b/],
    command: ({ port }) => `gatsby develop -p ${port}`,
  },
  {
    name: "Create React App",
    deps: ["react-scripts"],
    scripts: [/\breact-scripts\s+start\b/],
    // react-scripts has no port flag; PORT is the documented way, and it is still concrete.
    command: ({ port }) => `PORT=${port} react-scripts start`,
  },
  {
    name: "Vite",
    deps: ["vite"],
    scripts: [/\bvite\b/],
    command: ({ port }) => `vite --port ${port}`,
  },
  {
    name: "Static server",
    deps: ["serve", "http-server"],
    scripts: [/\bhttp-server\b/, /\bserve\b/],
    scriptNeedsDep: true,
    command: ({ port, pm, deps, script }) =>
      deps.has("http-server") || script?.includes("http-server")
        ? `${runner(pm)} http-server -p ${port}`
        : `${runner(pm)} serve -l ${port}`,
  },
];

function hasAnyDep(framework: Framework, deps: Set<string>): boolean {
  return framework.deps.some((d) => deps.has(d));
}

// ---------------------------------------------------------------------------
// JavaScript detection
// ---------------------------------------------------------------------------

/**
 * Scripts first, dependencies second.
 *
 * The dev script is what the project actually runs, so it outranks a package that merely sits
 * in the dependency list — that is the Next-app-that-also-has-vite case. When no script names
 * a framework we fall back to the dependency list and, if several frameworks are in it at once
 * (SvelteKit + vite, Astro + vite), we take the most specific one and say confidence is low.
 */
function detectFromPackageJson(pkg: PackageJson, ctx: Omit<CommandContext, "script">): DetectedStack | null {
  for (const { command } of pkg.scripts) {
    for (const framework of FRAMEWORKS) {
      if (framework.scriptNeedsDep && !hasAnyDep(framework, ctx.deps)) continue;
      if (framework.scripts.some((token) => token.test(command))) {
        return {
          framework: framework.name,
          command: framework.command({ ...ctx, script: command }),
          confidence: "high",
        };
      }
    }
  }

  const candidates = FRAMEWORKS.filter((f) => hasAnyDep(f, ctx.deps));
  const best = candidates[0];
  if (!best) return null;
  return {
    framework: best.name,
    command: best.command({ ...ctx, script: null }),
    confidence: candidates.length === 1 ? "high" : "low",
  };
}

// ---------------------------------------------------------------------------
// Monorepo root: the package.json that only delegates
// ---------------------------------------------------------------------------

/** Directories a script hands the work to: `--cwd pkg`, `--prefix pkg`, `-C pkg`, `cd pkg &&`. */
const DELEGATION_PATTERNS: readonly RegExp[] = [
  /--cwd[=\s]+(\S+)/g,
  /--prefix[=\s]+(\S+)/g,
  /\s-C\s+(\S+)/g,
  /\bcd\s+([^\s&;|]+)/g,
];

function delegatedDirs(pkg: PackageJson): string[] {
  const found: string[] = [];
  for (const { command } of pkg.scripts) {
    for (const pattern of DELEGATION_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of command.matchAll(pattern)) {
        const raw = match[1];
        if (raw) found.push(raw.replace(/^["']|["']$/g, ""));
      }
    }
  }
  return found;
}

/** Only `dir/*` and literal paths. A real glob engine would be a lot of code for no gain. */
async function expandWorkspaceGlob(root: string, pattern: string): Promise<string[]> {
  const cleaned = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned || cleaned.includes("..")) return [];
  if (!cleaned.includes("*")) return [cleaned];
  if (!cleaned.endsWith("/*")) return [];

  const parent = cleaned.slice(0, -2);
  try {
    const entries = await readdir(join(root, parent), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => `${parent}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/** Keeps us inside the folder the user pointed at; a script saying `cd ../..` is ignored. */
function isInside(root: string, candidate: string): boolean {
  if (isAbsolute(candidate)) return false;
  const rel = relative(root, join(root, candidate));
  return rel !== "" && !rel.startsWith("..");
}

/**
 * A monorepo root has no framework of its own; its dev script forwards to a child. We look at
 * the children it names, then at its workspaces, and report the first framework we recognise —
 * with the `cd` in front, because the command is only correct from that directory. Low
 * confidence by construction: a monorepo may well have several dev servers.
 */
async function detectDelegated(root: string, pkg: PackageJson, port: number): Promise<DetectedStack | null> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (rel: string) => {
    const cleaned = rel.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!cleaned || seen.has(cleaned) || !isInside(root, cleaned)) return;
    seen.add(cleaned);
    candidates.push(cleaned);
  };

  for (const rel of delegatedDirs(pkg)) push(rel);
  for (const pattern of pkg.workspaces) {
    for (const rel of await expandWorkspaceGlob(root, pattern)) push(rel);
  }

  for (const rel of candidates.slice(0, MAX_WORKSPACE_CANDIDATES)) {
    const child = join(root, rel);
    const childPkg = await readPackageJson(child);
    if (!childPkg) continue;
    const pm = (await detectPackageManager(child)) ?? (await detectPackageManager(root));
    const found = detectFromPackageJson(childPkg, { port, pm, deps: childPkg.deps });
    if (found) {
      return { framework: found.framework, command: `cd ${rel} && ${found.command}`, confidence: "low" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Everything that is not JavaScript
// ---------------------------------------------------------------------------

async function detectRuby(dir: string, port: number): Promise<DetectedStack | null> {
  const gemfile = await readFileOrNull(join(dir, "Gemfile"));
  const named = gemfile !== null && /^\s*gem\s+["']rails["']/m.test(gemfile);
  if (named || (await fileExists(join(dir, "bin/rails")))) {
    return { framework: "Rails", command: `rails s -p ${port}`, confidence: "high" };
  }
  return null;
}

async function detectPython(dir: string, port: number): Promise<DetectedStack | null> {
  const manage = await readFileOrNull(join(dir, "manage.py"));
  if (manage === null) return null;
  // manage.py is Django's own entrypoint, but say "low" if it does not mention Django at all.
  const confident = /django/i.test(manage);
  return {
    framework: "Django",
    command: `python manage.py runserver ${port}`,
    confidence: confident ? "high" : "low",
  };
}

async function detectPhp(dir: string, port: number): Promise<DetectedStack | null> {
  const composer = await readFileOrNull(join(dir, "composer.json"));
  const named = composer !== null && composer.includes("laravel/framework");
  if (named || (await fileExists(join(dir, "artisan")))) {
    return { framework: "Laravel", command: `php artisan serve --port=${port}`, confidence: "high" };
  }
  return null;
}

/**
 * A folder of files with an index.html. There is no dev server to name, so we name a server
 * that is always available: the project's own package manager if it has one, else python3,
 * which ships with macOS developer tooling.
 */
async function detectStatic(
  dir: string,
  port: number,
  pm: PackageManager | null,
): Promise<DetectedStack | null> {
  if (!(await fileExists(join(dir, "index.html")))) return null;
  const command = pm ? `${runner(pm)} serve -l ${port}` : `python3 -m http.server ${port}`;
  return { framework: "Static site", command, confidence: "low" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Identify the project in `dir` and give back the command that starts it on `port`.
 * Returns null — never throws, never guesses — when the folder says nothing recognisable.
 */
export async function detectStack(
  dir: string,
  port: number = DEFAULT_STACK_PORT,
): Promise<DetectedStack | null> {
  if (!dir) return null;
  const targetPort = isValidPort(port) ? port : DEFAULT_STACK_PORT;

  try {
    const pm = await detectPackageManager(dir);
    const pkg = await readPackageJson(dir);

    if (pkg) {
      const direct = detectFromPackageJson(pkg, { port: targetPort, pm, deps: pkg.deps });
      if (direct) return direct;
      const delegated = await detectDelegated(dir, pkg, targetPort);
      if (delegated) return delegated;
    }

    // A Rails or Laravel app very often also has a package.json for its assets, so these run
    // whether or not the JavaScript side said anything.
    return (
      (await detectRuby(dir, targetPort)) ??
      (await detectPython(dir, targetPort)) ??
      (await detectPhp(dir, targetPort)) ??
      (await detectStatic(dir, targetPort, pm))
    );
  } catch {
    // Unreadable folder, permission error, symlink loop: unknown, not a crash.
    return null;
  }
}
