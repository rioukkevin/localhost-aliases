import type { MetadataRoute } from "next";
import { DOC_PAGES } from "../lib/docs/pages.ts";
import { siteUrl } from "../lib/site.ts";

/**
 * Every route the site has. There are no dynamic segments beyond the doc slugs, so this list
 * plus DOC_PAGES is the whole site — and a route missing from here is a route search engines
 * only find by luck.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();

  return [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    // The page a reader is actually looking for, and the one that changes with every release.
    { url: `${base}/download`, lastModified, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/docs`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    ...DOC_PAGES.map((page) => ({
      url: `${base}/docs/${page.slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    { url: `${base}/faq`, lastModified, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/changelog`, lastModified, changeFrequency: "weekly", priority: 0.5 },
  ];
}
