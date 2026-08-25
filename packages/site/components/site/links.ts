/** Every off-site destination in one place, so a rename cannot leave a dead link behind. */
export const GITHUB_URL = "https://github.com/rioukkevin/localhost-aliases";
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

/** Header and footer navigation. Download first: it is what a reader came for. */
export const NAV_LINKS = [
  { href: "/download", label: "Download" },
  { href: "/docs", label: "Docs" },
  { href: "/faq", label: "FAQ" },
  { href: "/changelog", label: "Changelog" },
] as const;
