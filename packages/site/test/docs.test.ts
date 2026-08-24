/**
 * The docs are typed data, so the things that usually rot silently — duplicate slugs,
 * duplicate anchors, internal links to pages that do not exist — are checkable.
 */
import { describe, expect, test } from "bun:test";
import { DOC_PAGES, getDocPage } from "../lib/docs/pages.ts";
import { pageLinks, tokenizeInline } from "../lib/docs/schema.ts";

describe("doc pages", () => {
  test("the seven pages the site promises exist, in reading order", () => {
    expect(DOC_PAGES.map((page) => page.slug)).toEqual([
      "installation",
      "first-run",
      "how-aliases-work",
      "projects",
      "mcp",
      "uninstalling",
      "troubleshooting",
    ]);
  });

  test("slugs are unique and URL-safe", () => {
    const slugs = DOC_PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  test("every page has a title, a lede and at least one section", () => {
    for (const page of DOC_PAGES) {
      expect(page.title.length).toBeGreaterThan(0);
      expect(page.lede.length).toBeGreaterThan(0);
      expect(page.sections.length).toBeGreaterThan(0);
    }
  });

  test("anchors are unique within a page", () => {
    for (const page of DOC_PAGES) {
      const ids = page.sections.map((section) => section.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("no section is empty", () => {
    for (const page of DOC_PAGES) {
      for (const section of page.sections) {
        expect(section.blocks.length).toBeGreaterThan(0);
      }
    }
  });

  test("every table row matches its header width", () => {
    for (const page of DOC_PAGES) {
      for (const section of page.sections) {
        for (const block of section.blocks) {
          if (block.kind !== "table") continue;
          for (const row of block.rows) expect(row).toHaveLength(block.head.length);
        }
      }
    }
  });

  test("internal links point at routes that exist", () => {
    const known = new Set(["/", "/docs", "/changelog", ...DOC_PAGES.map((page) => `/docs/${page.slug}`)]);

    for (const page of DOC_PAGES) {
      for (const href of pageLinks(page)) {
        if (!href.startsWith("/")) continue;
        expect(known).toContain(href.split("#")[0]!);
      }
    }
  });

  test("external links are https", () => {
    for (const page of DOC_PAGES) {
      for (const href of pageLinks(page)) {
        if (href.startsWith("/")) continue;
        expect(href.startsWith("https://")).toBe(true);
      }
    }
  });

  test("getDocPage", () => {
    expect(getDocPage("mcp")?.title).toBe("MCP server");
    expect(getDocPage("nope")).toBeNull();
    expect(getDocPage("")).toBeNull();
  });

  test("the docs describe v2, not the v1 proxy", () => {
    const text = JSON.stringify(DOC_PAGES).toLowerCase();
    expect(text).toContain("127.0.0.2");
    expect(text).toContain("raw bytes");
    expect(text).toContain("http:// only");
    expect(text).toContain("# >>> localhost-aliases >>>");
    // v1's vocabulary. Either phrase would mean the docs describe an architecture we deleted.
    // (LaunchDaemon and SMAppService do appear — but only in the sentence saying there is none.)
    expect(text).not.toContain("reverse proxy");
    expect(text).not.toContain("http proxy");
  });

  test("no example teaches a hostname the app refuses", () => {
    const text = JSON.stringify(DOC_PAGES);

    // The app rejects `.local`, `.localhost` and the HSTS-preloaded TLDs, so an example under
    // one of them documents a name the user cannot create. Two names are deliberate and are
    // named here so a third cannot slip in unnoticed: `nope-xyz.local` is the subject of the
    // measurement, and `foo.dev` shows that the last label is what gets judged.
    const deliberate = new Set(["nope-xyz.local", "foo.dev"]);
    for (const hostname of text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(local|dev|app|page)\b/g) ?? []) {
      expect(deliberate).toContain(hostname);
    }
    expect(text).toContain("index.test");
  });

  test("the TLD rule is explained, not just applied", () => {
    const text = JSON.stringify(DOC_PAGES);
    expect(text).toContain("RFC 6761"); // why .test
    expect(text).toContain("RFC 6762"); // why not .local
    expect(text).toContain("HSTS"); // why not .dev / .app / .page
  });
});

describe("tokenizeInline", () => {
  test("plain text is one token", () => {
    expect(tokenizeInline("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });

  test("code spans", () => {
    expect(tokenizeInline("run `make dev` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "make dev" },
      { kind: "text", text: " now" },
    ]);
  });

  test("links and strong", () => {
    expect(tokenizeInline("see [docs](/docs) and **this**")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "docs", href: "/docs" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "this" },
    ]);
  });

  test("an unclosed backtick stays literal rather than eating the rest", () => {
    expect(tokenizeInline("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
  });

  test("empty string", () => {
    expect(tokenizeInline("")).toEqual([]);
  });
});
