/**
 * A stand-in for packages/web that implements exactly the endpoints
 * docs/ARCHITECTURE.md specifies, backed by the real core store against a temp
 * LA_CONFIG_DIR. It exists so the MCP server's happy path can be exercised over
 * real HTTP without booting Next.js (and without depending on the web package,
 * which lands in parallel).
 *
 * It never talks to the privileged helper and never touches /etc/hosts.
 */
import {
  ValidationError,
  createAlias,
  deleteAlias,
  listAliases,
  loadConfig,
  readWorkspace,
  toView,
} from "@localhost-aliases/core";
import type { AliasView, Project } from "@localhost-aliases/core";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function views(): Promise<AliasView[]> {
  const config = await loadConfig();
  // Status is not probed here: liveness is the web package's concern, not the MCP client's.
  return config.aliases.map((alias) => toView(alias, config, "down"));
}

export interface StubDashboard {
  port: number;
  stop: () => Promise<void>;
}

export function startStubDashboard(): StubDashboard {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/api/health") return json({ ok: true });

      if (pathname === "/api/aliases" && request.method === "GET") {
        return json({ aliases: await views() });
      }

      if (pathname === "/api/aliases" && request.method === "POST") {
        const input = (await request.json()) as Parameters<typeof createAlias>[0];
        try {
          const { config, alias } = await createAlias(input);
          return json({ alias: toView(alias, config, "down") }, 201);
        } catch (err) {
          if (err instanceof ValidationError) {
            return json({ error: err.message, issues: err.issues }, 400);
          }
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      const deleteMatch = pathname.match(/^\/api\/aliases\/(.+)$/);
      if (deleteMatch?.[1] && request.method === "DELETE") {
        try {
          const { config, alias } = await deleteAlias(decodeURIComponent(deleteMatch[1]));
          return json({ alias: toView(alias, config, "down") });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 404);
        }
      }

      if (pathname === "/api/projects" && request.method === "GET") {
        const config = await loadConfig();
        const all = await listAliases();
        const byPath = new Map<string, Project>();
        for (const alias of all) {
          if (!alias.projectPath) continue;
          let project = byPath.get(alias.projectPath);
          if (!project) {
            project = {
              path: alias.projectPath,
              name: alias.projectPath.split("/").filter(Boolean).pop() ?? alias.projectPath,
              hasWorkspaceFile: (await readWorkspace(alias.projectPath)) !== null,
              aliases: [],
            };
            byPath.set(alias.projectPath, project);
          }
          project.aliases.push(toView(alias, config, "down"));
        }
        return json({ projects: [...byPath.values()] });
      }

      return json({ error: `no route for ${request.method} ${pathname}` }, 404);
    },
  });

  return { port: Number(server.port), stop: async () => void (await server.stop(true)) };
}
