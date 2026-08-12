import { Panel } from "./Panel.tsx";

/**
 * What installing this actually grants. Mirrors the `instructions` text the MCP
 * server sends at `initialize` (packages/mcp/src/instructions.ts) — a user
 * deciding whether to install should read the same thing the agent is told.
 */
const TOOLS = [
  {
    name: "list_aliases",
    text: "Read every alias: hostname, URL, port, project folder, and whether the dev server behind it is answering right now.",
  },
  {
    name: "list_projects",
    text: "Read which folders have aliases attached, and whether each one has a workspace file.",
  },
  {
    name: "create_alias",
    text: "Add a name → port mapping. This is the one that reaches /etc/hosts, through the root helper.",
  },
  {
    name: "delete_alias",
    text: "Remove a mapping by name or id. The dev server on that port is not touched.",
  },
  {
    name: "link_project",
    text: "Register aliases for a folder you name, and write the optional .localhost-aliases.json inside it.",
  },
  {
    name: "get_usage_instructions",
    text: "Read the full transparency document — what the system does and what it will not do.",
  },
] as const;

const CHANGES = [
  "The managed block of /etc/hosts, and only between its two markers. Everything outside them is preserved byte for byte.",
  "The alias list in this dashboard's config file.",
  "The macOS DNS cache, flushed so a new name resolves immediately.",
  "One .localhost-aliases.json, and only in a folder passed explicitly to link_project.",
] as const;

const NEVER = [
  "Your source code, package.json, .env or dev-server configuration.",
  "The ports your dev servers listen on.",
  "Anything outside the /etc/hosts markers.",
  "Anything off this machine — no remote DNS, no deployment, no outbound traffic.",
] as const;

export function McpTransparency({ dashboardPort }: { dashboardPort: number }) {
  return (
    <div className="flex flex-col gap-5">
      <Panel title="What the agent gets" meta={`${TOOLS.length} tools`}>
        <ul className="flex flex-col divide-y divide-hairline">
          {TOOLS.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:gap-5">
              <span className="mono shrink-0 text-[12.5px] text-ink sm:w-[13rem]">{tool.name}</span>
              <span className="text-[12.5px] leading-relaxed text-muted">{tool.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-hairline pt-4 text-[12px] leading-relaxed text-muted">
          The MCP server holds no privileges of its own. It is a thin client of this dashboard&apos;s
          API on <span className="mono text-ink">127.0.0.1:{dashboardPort}</span>; if the dashboard
          is not running, every tool answers that it cannot reach it and does nothing. Writes to{" "}
          <span className="mono text-ink">/etc/hosts</span> still go through the same root helper and
          the same validation as the buttons in this UI.
        </p>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="What it can change here">
          <ul className="flex flex-col gap-2.5">
            {CHANGES.map((line) => (
              <li key={line} className="flex gap-2.5 text-[12.5px] leading-relaxed text-muted">
                <span aria-hidden="true" className="text-down">
                  ●
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="What it never touches">
          <ul className="flex flex-col gap-2.5">
            {NEVER.map((line) => (
              <li key={line} className="flex gap-2.5 text-[12.5px] leading-relaxed text-muted">
                <span aria-hidden="true" className="text-live">
                  ●
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
