import type { MetadataRoute } from "next";
import { DOC_PAGES } from "../lib/docs/pages.ts";
import { siteUrl } from "../lib/site.ts";

/** Every route the site has. There are no dynamic segments beyond the doc slugs. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();

  return [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/docs`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    ...DOC_PAGES.map((page) => ({
      url: `${base}/docs/${page.slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    { url: `${base}/changelog`, lastModified, changeFrequency: "weekly", priority: 0.5 },
  ];
}
