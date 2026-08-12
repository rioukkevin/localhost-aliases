import { expect, test } from "@playwright/test";
import { lastApply, startHelper, waitForApply } from "../fixtures/helper-control";
import { managedHostnames, readConfig, readHostsFile, resetState } from "../fixtures/state";

test.beforeAll(async () => {
  await startHelper();
});

test.beforeEach(async () => {
  await resetState();
});

test("first run shows the empty patchbay", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("alias-empty")).toBeVisible();
  await expect(page.getByTestId("alias-row")).toHaveCount(0);
  await expect(page.getByTestId("alias-create-form")).toBeVisible();
  // The helper is up, so the "install it" banner must not be shouting.
  await expect(page.getByTestId("helper-banner")).toHaveCount(0);
});

test("an alias created in the UI reaches the helper, the hosts file, and back out again", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("alias-empty")).toBeVisible();

  await page.getByTestId("alias-name-input").fill("shop");
  await page.getByTestId("alias-port-input").fill("3000");
  await page.getByTestId("alias-submit").click();

  const row = page.locator('[data-testid="alias-row"][data-alias="shop.local"]');
  await expect(row).toBeVisible();
  await expect(page.getByTestId("alias-empty")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("shop.local patched to :3000");

  // The helper received the complete desired state, not just a diff.
  const applied = await waitForApply((req) =>
    req.routes.some((route) => route.host === "shop.local"),
  );
  expect(applied.routes).toHaveLength(1);
  expect(applied.routes[0]).toMatchObject({ host: "shop.local", port: 3000, target: "127.0.0.1" });
  expect(applied.tls).toBeNull();

  // ...and turned it into a managed block, without touching anything around it.
  await expect.poll(managedHostnames).toEqual(["shop.local"]);
  const hosts = readHostsFile();
  expect(hosts).toContain("127.0.0.1\tshop.local");
  expect(hosts).toContain("::1\tshop.local");
  expect(hosts).toContain("255.255.255.255\tbroadcasthost");
  expect(hosts).toContain("# Host Database");

  // Copy URL.
  const copy = row.getByTestId("copy");
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied URL for shop.local");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("http://shop.local");

  // Delete, behind an explicit confirmation.
  await row.getByTestId("alias-delete").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Unpatch shop.local?");
  await dialog.getByTestId("confirm-accept").click();

  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("alias-empty")).toBeVisible();
  await waitForApply((req) => req.routes.length === 0);
  await expect.poll(managedHostnames).toEqual([]);
  expect(readHostsFile()).toContain("255.255.255.255\tbroadcasthost");
  expect(readConfig()?.aliases).toEqual([]);
});

test("a created alias survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("alias-name-input").fill("api");
  await page.getByTestId("alias-port-input").fill("4000");
  await page.getByTestId("alias-submit").click();
  await expect(page.locator('[data-testid="alias-row"][data-alias="api.local"]')).toBeVisible();
  await waitForApply((req) => req.routes.some((route) => route.host === "api.local"));

  await page.reload();

  const row = page.locator('[data-testid="alias-row"][data-alias="api.local"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("4000");
  expect(lastApply()?.routes.map((route) => route.host)).toEqual(["api.local"]);
});
