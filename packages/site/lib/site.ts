/**
 * The site's own absolute origin, for sitemap.xml, robots.txt and canonical URLs.
 *
 * No domain is hardcoded: the production host is whatever Vercel says it is, unless
 * NEXT_PUBLIC_SITE_URL overrides it. Locally that resolves to the dev server, which is
 * correct — a sitemap claiming a domain the deployment does not own is a lie.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;

  return "http://localhost:3100";
}
