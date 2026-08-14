/**
 * The one-page dashboard, rendered.
 *
 * The page is a client component fed by a polled store, so its rows never exist in the
 * server's HTML — a curl can only prove the shell. These tests render the same
 * components against a seeded store to prove the rows themselves.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AliasView } from "@localhost-aliases/core/types";
import { UnassignedList } from "../components/aliases/UnassignedList.tsx";
import { ProjectDrawer } from "../components/projects/ProjectDrawer.tsx";
import { ProjectGrid } from "../components/projects/ProjectGrid.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";

function alias(over: Partial<AliasView> & { name: string; port: number }): AliasView {
  const now = new Date().toISOString();
  return {
    id: `id-${over.name}`,
    ip: "127.0.0.2",
    projectPath: null,
    description: null,
    enabled: true,
    reserved: false,
    createdAt: now,
    updatedAt: now,
    hostname: `${over.name}.local`,
    url: `http://${over.name}.local`,
    status: "up",
    ...over,
  };
}

const ALIASES = [
  alias({ name: "index", port: 7788, reserved: true, ip: "127.0.0.2" }),
  alias({ name: "loose-one", port: 5173, ip: "127.0.0.3" }),
  alias({ name: "shop", port: 3000, ip: "127.0.0.4", projectPath: "/Users/kevin/code/shop" }),
];

const PROJECT = {
  path: "/Users/kevin/code/shop",
  name: "shop",
  aliases: [ALIASES[2]!],
  live: 1,
  hasWorkspaceFile: true,
};

describe("project grid", () => {
  test("draws a card per folder, with the path tilde-abbreviated", () => {
    const html = renderToStaticMarkup(
      <ProjectGrid
        projects={[PROJECT]}
        loaded
        linking={false}
        onAdd={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('data-testid="project-card"');
    expect(html).toContain("shop");
    expect(html).toContain("~/code/shop");
    expect(html).not.toContain("/Users/kevin/code/shop<");
    expect(html).toContain("1 alias");
    expect(html).toContain("1 live");
    expect(html).toContain(".localhost-aliases.json");
    // The add-a-folder affordance is always the last cell.
    expect(html).toContain('data-testid="add-project"');
    expect(html).toContain('data-testid="folder-picker"');
  });

  test("the empty grid teaches what a project is and still offers the picker", () => {
    const html = renderToStaticMarkup(
      <ProjectGrid projects={[]} loaded linking={false} onAdd={() => {}} onOpen={() => {}} />,
    );
    expect(html).toContain("No projects yet");
    expect(html).toContain("folder that some aliases point at");
    expect(html).toContain('data-testid="folder-picker"');
    expect(html).not.toContain('data-testid="project-card"');
  });

  test("one column on narrow viewports", () => {
    const html = renderToStaticMarkup(
      <ProjectGrid
        projects={[PROJECT]}
        loaded
        linking={false}
        onAdd={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("sm:grid-cols-2");
  });
});

describe("project drawer", () => {
  const open = renderToStaticMarkup(
    <ToastProvider>
      <ProjectDrawer
        project={PROJECT}
        aliases={ALIASES}
        tld="local"
        writing={null}
        onClose={() => {}}
        onWriteWorkspace={async () => {}}
      />
    </ToastProvider>,
  );

  test("renders nothing until a card is clicked", () => {
    const closed = renderToStaticMarkup(
      <ToastProvider>
        <ProjectDrawer
          project={null}
          aliases={ALIASES}
          tld="local"
          writing={null}
          onClose={() => {}}
          onWriteWorkspace={async () => {}}
        />
      </ToastProvider>,
    );
    expect(closed).not.toContain('data-testid="project-drawer"');
  });

  test("opens from the right with the folder's aliases as patchbay rows", () => {
    expect(open).toContain('data-testid="project-drawer"');
    expect(open).toContain('data-side="right"');
    expect(open).toContain('role="dialog"');
    expect(open).toContain('data-testid="alias-row"');
    expect(open).toContain("shop");
    expect(open).toContain("~/code/shop");
  });

  test("carries every per-alias action plus add, attach and the workspace file", () => {
    expect(open).toContain("Copy URL");
    expect(open).toContain("Open shop.local");
    expect(open).toContain("Edit shop.local");
    expect(open).toContain("Delete shop.local");
    expect(open).toContain("Detach shop.local from its folder");
    expect(open).toContain("Patch it here");
    expect(open).toContain("Attach an existing alias");
    expect(open).toContain("Rewrite file");
  });
});

describe("unassigned list", () => {
  const html = renderToStaticMarkup(
    <ToastProvider>
      <UnassignedList aliases={ALIASES} tld="local" loaded busy={false} />
    </ToastProvider>,
  );

  test("lists only the aliases with no project", () => {
    expect(html).toContain('data-testid="unassigned-list"');
    expect(html).toContain('data-testid="alias-row"');
    expect(html).toContain("loose-one");
    // The project's alias belongs to the drawer, not here.
    expect(html).not.toContain("shop.local");
  });

  test("the reserved dashboard row is visibly special and has no delete", () => {
    expect(html).toContain('data-testid="reserved-section"');
    expect(html).toContain("reserved — it cannot be renamed or deleted");
    expect(html).toContain("Delete loose-one.local");
    expect(html).not.toContain("Delete index.local");
    expect(html).not.toContain("Edit index.local");
  });

  test("carries an inline create form", () => {
    expect(html).toContain("new alias");
    expect(html).toContain("Patch it");
    expect(html).toContain('placeholder="myapp"');
  });
});
