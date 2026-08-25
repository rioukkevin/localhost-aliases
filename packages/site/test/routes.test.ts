/**
 * A route that is not in the sitemap is a route search engines find only by luck, and a page
 * with no link into it is a page nobody finds at all. Both are easy to forget when adding a
 * page, so both are checked here.
 */
import { describe, expect, test } from "bun:test";
import sitemap from "../app/sitemap.ts";
import { NAV_LINKS } from "../components/site/links.ts";
import { DOC_PAGES } from "../lib/docs/pages.ts";
import { siteUrl } from "../lib/site.ts";

const PAGES = ["/", "/download", "/docs", "/faq", "/changelog", ...DOC_PAGES.map((page) => `/docs/${page.slug}`)];

describe("sitemap", () => {
  test("lists every route the site has, exactly once", () => {
    const base = siteUrl();
    const urls = sitemap().map((entry) => entry.url);

    expect(new Set(urls).size).toBe(urls.length);
    expect([...urls].sort()).toEqual([...PAGES.map((path) => `${base}${path}`)].sort());
  });

  test("every entry is absolute and carries a priority", () => {
    for (const entry of sitemap()) {
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(typeof entry.priority).toBe("number");
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });
});

describe("navigation", () => {
  test("the download page is linked from the header and the footer", () => {
    // Both chrome components render NAV_LINKS, so one assertion covers both.
    expect(NAV_LINKS.map((link) => link.href)).toContain("/download");
    expect(NAV_LINKS[0]?.href).toBe("/download");
  });

  test("every new route is reachable from the chrome", () => {
    const hrefs: string[] = NAV_LINKS.map((link) => link.href);
    for (const path of ["/download", "/docs", "/faq", "/changelog"]) {
      expect(hrefs).toContain(path);
    }
  });
});
