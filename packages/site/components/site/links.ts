/** Every off-site destination in one place, so a rename cannot leave a dead link behind. */
export const GITHUB_URL = "https://github.com/rioukkevin/localhost-aliases";
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;

export const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
] as const;
