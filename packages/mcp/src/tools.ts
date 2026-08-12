/**
 * Tool definitions. Each one: validate input (zod), call the dashboard API,
 * render both a sentence and a structured payload.
 *
 * The only filesystem write in this whole package lives in `link_project`, and it
 * is limited to the project-local `.localhost-aliases.json`.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  WORKSPACE_FILENAME,
  mergeWorkspaceAliases,
  workspacePath,
} from "@localhost-aliases/core";
import type { WorkspaceAliasEntry } from "@localhost-aliases/core";
import { baseUrl, deleteAliasById, fetchAliases, fetchProjects, postAlias } from "./client.ts";
import { usageInstructions } from "./instructions.ts";
import { livePaths } from "./paths.ts";
import { fromFailure, ok, problem } from "./result.ts";
import {
  renderAliasList,
  renderProjectList,
  toAliasSummary,
  toProjectSummary,
} from "./views.ts";
import type { AliasSummary } from "./views.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const aliasSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  url: z.string(),
  port: z.number(),
  target: z.string(),
  projectPath: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  status: z.enum(["up", "down", "unknown"]),
});

const projectSchema = z.object({
  path: z.string(),
  name: z.string(),
  hasWorkspaceFile: z.boolean(),
  aliases: z.array(aliasSchema),
});

/**
 * Output schemas are declared as an envelope: `ok` plus the success payload
 * (optional) plus the failure fields (optional). Both the server and the client
 * SDK validate structuredContent against this schema, and an `isError` result is
 * still a structured result — so one schema has to describe both halves.
 */
const failureShape = {
  ok: z
    .boolean()
    .describe("false when the call failed; `error` and `kind` then explain why and the payload fields are absent."),
  error: z.string().optional(),
  kind: z
    .string()
    .optional()
    .describe(
      'Failure category: "dashboard-unreachable", "invalid-input", "not-found", "api-error" or "workspace-write-failed".',
    ),
  status: z.number().optional().describe("HTTP status returned by the dashboard, when there was one."),
  issues: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .optional()
    .describe("Field-level validation problems."),
  known: z.array(z.string()).optional().describe("Hostnames that do exist, when a lookup failed."),
  dashboardUrl: z.string().optional(),
};

function envelope<T extends z.ZodRawShape>(success: T) {
  const optional = Object.fromEntries(
    Object.entries(success).map(([key, schema]) => [key, schema.optional()]),
  ) as { [K in keyof T]: z.ZodOptional<T[K]> };
  return { ...failureShape, ...optional };
}

const nameArg = z
  .string()
  .describe(
    'Host label without the TLD, e.g. "acme-shop" (reachable as acme-shop.local). Lowercase letters, digits and hyphens; dots separate labels. "localhost", "local" and "broadcasthost" are reserved.',
  );

const portArg = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .describe("Port your dev server already listens on. It is not changed — traffic is proxied to it.");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accepts "~/x", rejects anything relative: the MCP server's cwd is not the user's. */
function resolveProjectDir(raw: string): { ok: true; dir: string } | { ok: false; reason: string } {
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    return {
      ok: false,
      reason: `"${raw}" is not an absolute path. Pass the project's absolute folder path (this server does not share your shell's working directory).`,
    };
  }
  if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
    return { ok: false, reason: `"${expanded}" is not an existing folder. No file was written.` };
  }
  return { ok: true, dir: expanded };
}

function matches(alias: AliasSummary, needle: string): boolean {
  const lower = needle.toLowerCase();
  return alias.name.toLowerCase() === lower || alias.hostname.toLowerCase() === lower;
}

/**
 * The dashboard saves first and applies second, so a `warning` means the config
 * changed but the hosts file did not. Saying "we edited the hosts file" in that case
 * would be a lie, so the note is swapped rather than appended.
 */
function changeNote(warning: string | undefined): string {
  const path = livePaths();
  if (!warning) {
    return `Changed: the managed block of ${path.hosts} (via the root helper) and ${path.config}. Your project files, dev server and ports were not touched.`;
  }
  return [
    `Saved to ${path.config}, but it was NOT applied to the system: ${warning}`,
    `${path.hosts} is unchanged and the hostname will not resolve until the privileged helper is installed and running (\`sudo ./scripts/install.sh\`). Your project files were not touched either way.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_aliases",
    {
      title: "List aliases",
      description:
        "List every registered localhost alias with its hostname, URL, upstream port, project folder and live status. Call this before creating anything: reuse an alias that already points at your port or project instead of creating a duplicate.",
      inputSchema: {},
      outputSchema: envelope({
        aliases: z.array(aliasSchema),
        count: z.number(),
        dashboardUrl: z.string(),
      }),
    },
    async () => {
      const result = await fetchAliases();
      if (!result.ok) return fromFailure(result, "list aliases");
      const aliases = result.data.map(toAliasSummary);
      return ok(renderAliasList(aliases), {
        aliases,
        count: aliases.length,
        dashboardUrl: baseUrl(),
      });
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: `List folders that have aliases attached, and whether each one has a ${WORKSPACE_FILENAME} workspace file. That file is optional — a project without one works exactly the same.`,
      inputSchema: {},
      outputSchema: envelope({ projects: z.array(projectSchema), count: z.number() }),
    },
    async () => {
      const result = await fetchProjects();
      if (!result.ok) return fromFailure(result, "list projects");
      const projects = result.data.map(toProjectSummary);
      return ok(renderProjectList(projects), { projects, count: projects.length });
    },
  );

  server.registerTool(
    "create_alias",
    {
      title: "Create alias",
      description: `Register a new hostname for a local port. This writes one line into the managed block of ${livePaths().hosts} through the privileged helper and adds a route to the local reverse proxy; it does not change your project, your dev server or its port. Call list_aliases first and reuse an existing alias when one already fits.`,
      inputSchema: {
        name: nameArg,
        port: portArg,
        projectPath: z
          .string()
          .optional()
          .describe("Absolute path of the project folder this alias belongs to (for grouping in the dashboard)."),
        description: z.string().optional().describe("Free-form label shown in the dashboard."),
      },
      outputSchema: envelope({ alias: aliasSchema, warning: z.string() }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, port, projectPath, description }) => {
      const result = await postAlias({
        name,
        port,
        projectPath: projectPath ?? null,
        description: description ?? null,
      });
      if (!result.ok) return fromFailure(result, `create alias "${name}"`);
      if (!result.data?.alias) {
        return problem(
          `The dashboard accepted the request but returned no alias for "${name}". Call list_aliases to check whether it was created.`,
          { kind: "api-error" },
        );
      }
      const alias = toAliasSummary(result.data.alias);
      const warning = result.data.warning;
      const text = [
        `Created ${alias.hostname} -> ${alias.target}:${alias.port}. Open ${alias.url}`,
        changeNote(warning),
        alias.status === "up"
          ? "The upstream port is already listening, so the URL works now."
          : `Nothing is listening on port ${alias.port} yet: start your dev server and the URL becomes your app (the proxy serves a self-refreshing placeholder until then).`,
      ].join("\n");
      return ok(text, warning ? { alias, warning } : { alias });
    },
  );

  server.registerTool(
    "delete_alias",
    {
      title: "Delete alias",
      description: `Remove an alias by name or id. Its line disappears from the managed block of ${livePaths().hosts} and its proxy route is dropped. Nothing else is removed — your project files and dev server are untouched.`,
      inputSchema: {
        name: z.string().optional().describe('Alias name or full hostname, e.g. "acme-shop" or "acme-shop.local".'),
        id: z.string().optional().describe("Alias id as returned by list_aliases."),
      },
      outputSchema: envelope({ deleted: aliasSchema, warning: z.string() }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, id }) => {
      if (!name && !id) {
        return problem("delete_alias needs at least one of { name, id }. Call list_aliases to see both.", {
          kind: "invalid-input",
          issues: [{ field: "name", message: "provide either name or id" }],
        });
      }

      // The API deletes by id, so a name has to be resolved against the live list first.
      const list = await fetchAliases();
      if (!list.ok) return fromFailure(list, "delete an alias");
      const aliases = list.data.map(toAliasSummary);
      const target = aliases.find((alias) => (id ? alias.id === id : false) || (name ? matches(alias, name) : false));
      if (!target) {
        const known = aliases.map((alias) => alias.hostname);
        return problem(
          `No alias matches ${id ? `id "${id}"` : `name "${name}"`}. ${
            known.length ? `Registered aliases: ${known.join(", ")}.` : "There are no aliases registered."
          }`,
          { kind: "not-found", known },
        );
      }

      const result = await deleteAliasById(target.id);
      if (!result.ok) return fromFailure(result, `delete alias "${target.hostname}"`);
      const warning = result.data?.warning;
      const text = [
        `Deleted ${target.hostname} (was -> ${target.target}:${target.port}).`,
        warning
          ? `Removed from the config, but the system was NOT updated: ${warning} Its ${livePaths().hosts} line stays until the helper runs again.`
          : `Its ${livePaths().hosts} line and proxy route are gone; the rest of ${livePaths().hosts} and all project files are unchanged.`,
      ].join("\n");
      return ok(text, warning ? { deleted: target, warning } : { deleted: target });
    },
  );

  server.registerTool(
    "link_project",
    {
      title: "Link project",
      description: `Register the given aliases and record them in ${WORKSPACE_FILENAME} inside the project folder. The workspace file is an optional, committable note of the names a repo expects — nothing reads it at runtime. Existing aliases are reused, not duplicated, and unknown keys already in the file are preserved.`,
      inputSchema: {
        path: z.string().describe("Absolute path of the project folder. The workspace file is written here."),
        aliases: z
          .array(
            z.object({
              name: nameArg,
              port: portArg,
              description: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Aliases this project expects."),
      },
      outputSchema: envelope({
        path: z.string(),
        workspaceFile: z.string(),
        created: z.number(),
        reused: z.number(),
        failed: z.number(),
        aliases: z.array(
          z.object({
            name: z.string(),
            port: z.number(),
            outcome: z.enum(["created", "reused", "failed"]),
            hostname: z.string().optional(),
            url: z.string().optional(),
            note: z.string().optional(),
          }),
        ),
      }),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, aliases }) => {
      const dir = resolveProjectDir(path);
      if (!dir.ok) return problem(dir.reason, { kind: "invalid-input" });

      // Registration first: if the dashboard is down we fail before writing anything
      // into the user's repository.
      const list = await fetchAliases();
      if (!list.ok) return fromFailure(list, "link the project");
      const existing = list.data.map(toAliasSummary);

      // The last apply warning, if any: reported once rather than per alias.
      let applyWarning: string | undefined;
      const outcomes: {
        name: string;
        port: number;
        outcome: "created" | "reused" | "failed";
        hostname?: string;
        url?: string;
        note?: string;
      }[] = [];

      for (const entry of aliases) {
        const already = existing.find((alias) => matches(alias, entry.name));
        if (already) {
          outcomes.push({
            name: entry.name,
            port: already.port,
            outcome: "reused",
            hostname: already.hostname,
            url: already.url,
            note:
              already.port === entry.port
                ? undefined
                : `already registered on port ${already.port}, not ${entry.port} — left as is`,
          });
          continue;
        }
        const created = await postAlias({
          name: entry.name,
          port: entry.port,
          projectPath: dir.dir,
          description: entry.description ?? null,
        });
        if (!created.ok || !created.data?.alias) {
          outcomes.push({
            name: entry.name,
            port: entry.port,
            outcome: "failed",
            note: created.ok ? "the dashboard returned no alias" : created.message,
          });
          continue;
        }
        const alias = toAliasSummary(created.data.alias);
        applyWarning = created.data.warning ?? applyWarning;
        outcomes.push({
          name: entry.name,
          port: alias.port,
          outcome: "created",
          hostname: alias.hostname,
          url: alias.url,
        });
      }

      // Record intent for every requested alias, including any that failed to
      // register — the file is a declaration, not a mirror of live state.
      const entries: WorkspaceAliasEntry[] = aliases.map((entry) => ({
        name: entry.name,
        port: entry.port,
        ...(entry.description ? { description: entry.description } : {}),
      }));
      let file: string;
      try {
        await mergeWorkspaceAliases(dir.dir, entries);
        file = workspacePath(dir.dir);
      } catch (err) {
        return problem(
          `Aliases were registered, but ${workspacePath(dir.dir)} could not be written: ${
            err instanceof Error ? err.message : String(err)
          }. The workspace file is optional, so the aliases still work.`,
          { kind: "workspace-write-failed", path: dir.dir },
        );
      }

      const counts = {
        created: outcomes.filter((o) => o.outcome === "created").length,
        reused: outcomes.filter((o) => o.outcome === "reused").length,
        failed: outcomes.filter((o) => o.outcome === "failed").length,
      };
      const text = [
        `Linked ${dir.dir}`,
        `  ${counts.created} created, ${counts.reused} reused, ${counts.failed} failed.`,
        ...outcomes.map(
          (o) => `  ${o.outcome.padEnd(7)} ${o.hostname ?? o.name} -> :${o.port}${o.note ? `  (${o.note})` : ""}`,
        ),
        `Wrote ${file} (optional workspace file: a committable record of these names; nothing reads it at runtime).`,
        changeNote(applyWarning),
      ].join("\n");
      return ok(text, { path: dir.dir, workspaceFile: file, aliases: outcomes, ...counts });
    },
  );

  server.registerTool(
    "get_usage_instructions",
    {
      title: "Usage instructions",
      description: `Explain what localhost-aliases does, exactly what it changes on this machine (${livePaths().hosts} and ${livePaths().config}) and what it never changes, how to decide between reusing and creating an alias, and the optional workspace file format. Read this before using the other tools.`,
      inputSchema: {},
      outputSchema: envelope({ instructions: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const text = usageInstructions();
      return ok(text, { instructions: text });
    },
  );
}
