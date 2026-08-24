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
    hostname: `${over.name}.test`,
    url: `http://${over.name}.test`,
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
  stack: { framework: "Next.js", command: "next dev -p 3000", confidence: "high" as const },
};

/** The same folder, unrecognised — the case the UI must state rather than paper over. */
const UNKNOWN_PROJECT = { ...PROJECT, stack: null };

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

  test("the card names the detected stack", () => {
    const html = renderToStaticMarkup(
      <ProjectGrid projects={[PROJECT]} loaded linking={false} onAdd={() => {}} onOpen={() => {}} />,
    );
    expect(html).toContain('data-testid="project-stack"');
    expect(html).toContain("Next.js");
    // The command itself belongs in the drawer, where there is room for it.
    expect(html).not.toContain("next dev -p 3000");
  });

  test("an unrecognised folder says so on the card instead of leaving a gap", () => {
    const html = renderToStaticMarkup(
      <ProjectGrid
        projects={[UNKNOWN_PROJECT]}
        loaded
        linking={false}
        onAdd={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('data-testid="project-stack"');
    expect(html).toContain("unknown stack");
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
    expect(open).toContain("Open shop.test");
    expect(open).toContain("Edit shop.test");
    expect(open).toContain("Delete shop.test");
    expect(open).toContain("Detach shop.test from its folder");
    expect(open).toContain("Patch it here");
    expect(open).toContain("Attach an existing alias");
    expect(open).toContain("Rewrite file");
  });

  test("shows the exact command that starts this folder on its port", () => {
    expect(open).toContain('data-testid="drawer-command"');
    expect(open).toContain("next dev -p 3000");
    expect(open).toContain("Next.js");
  });

  test("an unrecognised folder gets a sentence, never a guessed command", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ProjectDrawer
          project={UNKNOWN_PROJECT}
          aliases={ALIASES}
          tld="local"
          writing={null}
          onClose={() => {}}
          onWriteWorkspace={async () => {}}
        />
      </ToastProvider>,
    );
    expect(html).toContain("We do not recognise this folder");
    expect(html).not.toContain('data-testid="drawer-command"');
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
    expect(html).not.toContain("shop.test");
  });

  test("the reserved dashboard row is visibly special and has no delete", () => {
    expect(html).toContain('data-testid="reserved-section"');
    expect(html).toContain("reserved — it cannot be renamed or deleted");
    expect(html).toContain("Delete loose-one.test");
    expect(html).not.toContain("Delete index.test");
    expect(html).not.toContain("Edit index.test");
  });

  test("carries an inline create form", () => {
    expect(html).toContain("New alias");
    expect(html).toContain("Patch it");
    expect(html).toContain('placeholder="myapp"');
  });

  /**
   * The reported bug: the form was never broken or hidden, it was unfindable — last thing
   * on the longest page, labelled with a 10px caption. These three assertions are the fix.
   */
  test("the form is findable: a header button, a real heading, and a folder-optional line", () => {
    expect(html).toContain('data-testid="new-alias"');
    expect(html).toContain('data-testid="new-alias-form"');
    expect(html).toContain('<h3 class="text-[13px] font-semibold tracking-tight text-ink">New alias</h3>');
    expect(html).toContain("A folder is optional");
  });

  test("the empty list offers the same affordance where the eye already is", () => {
    const empty = renderToStaticMarkup(
      <ToastProvider>
        <UnassignedList
          aliases={[ALIASES[0]!, ALIASES[2]!]}
          tld="local"
          loaded
          busy={false}
        />
      </ToastProvider>,
    );
    expect(empty).toContain('data-testid="new-alias-empty"');
    expect(empty).toContain("Every alias belongs to a folder");
  });

  test("the header button stays available while a mutation is in flight", () => {
    const busy = renderToStaticMarkup(
      <ToastProvider>
        <UnassignedList aliases={ALIASES} tld="local" loaded busy />
      </ToastProvider>,
    );
    expect(busy).toContain("applying…");
    expect(busy).toContain('data-testid="new-alias"');
  });
});
