/**
 * The way out, in the settings drawer.
 *
 * The old section could only tell the user to go and find a source checkout. The teardown now
 * ships inside the bundle, so this panel starts the real thing — by ASKING the menu-bar app,
 * because this process is unprivileged and stays that way.
 *
 * `useSyncExternalStore` hands a server render the store's EMPTY snapshot, so what a render can
 * prove here is the copy and the affordance, which is exactly what has to be honest.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { REMOVED, UninstallSection } from "../components/settings/UninstallSection.tsx";

const html = () => renderToStaticMarkup(<UninstallSection />);

describe("what the uninstall panel promises", () => {
  test("names every step teardown.sh performs, before anything is pressed", () => {
    const markup = html();
    // Not behind a disclosure toggle: the list is what will be removed.
    expect(markup).toContain('data-testid="uninstall-plan"');
    for (const line of REMOVED) {
      // React escapes the copy, so match on a distinctive fragment of each line.
      const fragment = line.split(" — ")[0]!.split(", ")[0]!;
      expect(markup).toContain(fragment.replace(/&/g, "&amp;"));
    }
  });

  test("covers the five things a full uninstall touches plus the app itself", () => {
    const all = REMOVED.join("\n");
    expect(all).toContain("/etc/hosts");
    expect(all).toContain("lo0");
    expect(all).toContain("root agent");
    expect(all).toContain("login keychain");
    expect(all).toContain("~/.config/localhost-aliases");
    expect(all).toContain("the app itself");
    expect(REMOVED).toHaveLength(6);
  });

  test("says a failed step does not stop the rest, and that none of it can be undone", () => {
    const markup = html();
    expect(markup).toContain("the rest still run");
    expect(markup).toContain("cannot be undone");
  });

  test("offers a button rather than only a command to type", () => {
    const markup = html();
    expect(markup).toContain('data-testid="uninstall"');
    expect(markup).toContain("Uninstall…");
  });

  test("still shows `make uninstall`, and says it is the same script", () => {
    const markup = html();
    expect(markup).toContain("make uninstall");
    expect(markup).toContain("identical script");
  });

  test("no longer claims the uninstall can only be run from somewhere else", () => {
    const markup = html();
    expect(markup).not.toContain("does not run from this page");
    expect(markup).not.toContain("Use the menu-bar item, or run this in the repo");
  });
});
