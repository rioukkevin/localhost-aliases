import { expect, test } from "@playwright/test";
import { helperStatus, readJournal, startHelper, stopHelper } from "../fixtures/helper-control";
import { managedHostnames, readConfig, readHostsFile, resetState } from "../fixtures/state";

/**
 * The most important spec in the suite: this is the state a user is in the first
 * time they open the dashboard. The privileged helper is not installed, so
 * nothing can write /etc/hosts or answer on :80 — and the dashboard still has to
 * work, say so, and keep every write the user makes.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await stopHelper();
  expect(await helperStatus()).toBeNull();
});

test.afterAll(async () => {
  await startHelper();
});

test.beforeEach(async () => {
  await resetState();
});

test("the dashboard renders and names the command that fixes it", async ({ page }) => {
  await page.goto("/");

  const banner = page.getByTestId("helper-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("The privileged helper is not installed");
  await expect(banner).toContainText("sudo ./scripts/install.sh");
  await expect(page.getByTestId("status-strip")).toContainText("not installed");

  // The rest of the page is fully functional, not a crash screen.
  await expect(page.getByTestId("alias-create-form")).toBeVisible();
  await expect(page.getByTestId("alias-empty")).toBeVisible();
});

test("creating an alias still persists, with a warning instead of a 500", async ({
  page,
  request,
}) => {
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/") && res.status() >= 500) {
      failures.push(`${res.status()} ${res.url()}`);
    }
  });

  await page.goto("/");
  await page.getByTestId("alias-name-input").fill("shop");
  await page.getByTestId("alias-port-input").fill("3000");
  await page.getByTestId("alias-submit").click();

  const row = page.locator('[data-testid="alias-row"][data-alias="shop.local"]');
  await expect(row).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Your changes were saved");
  await expect(page.getByTestId("toast")).toContainText("privileged helper could not be updated");

  // It really hit the disk, and it survives a reload.
  await expect.poll(() => readConfig()?.aliases.map((alias) => alias.name)).toEqual(["shop"]);
  await page.reload();
  await expect(row).toBeVisible();
  await expect(page.getByTestId("helper-banner")).toBeVisible();

  // Nothing pretended to be applied: no hosts entry, no apply journalled.
  expect(managedHostnames()).toEqual([]);
  expect(readHostsFile()).toContain("255.255.255.255\tbroadcasthost");
  expect(readJournal()).toHaveLength(0);
  expect(failures).toEqual([]);

  // The API says the same thing on its own: 201 plus a warning, never an error.
  const res = await request.post("/api/aliases", { data: { name: "api", port: 4000 } });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { alias: { hostname: string }; warning?: string };
  expect(body.alias.hostname).toBe("api.local");
  expect(body.warning).toContain("privileged helper could not be updated");
});

test("settings still save while the helper is gone", async ({ page, request }) => {
  expect((await request.post("/api/aliases", { data: { name: "shop", port: 3000 } })).status()).toBe(
    201,
  );

  await page.goto("/settings");
  await page.getByTestId("settings-tld-input").fill("test");
  await page.getByTestId("settings-apply").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-accept").click();

  const receipt = page.getByTestId("settings-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("not applied");
  await expect.poll(() => readConfig()?.tld).toBe("test");
  expect(managedHostnames()).toEqual([]);
});
