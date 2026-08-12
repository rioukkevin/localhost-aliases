import { expect, test } from "@playwright/test";
import { startHelper, waitForApply } from "../fixtures/helper-control";
import { managedHostnames, readHostsFile, resetState } from "../fixtures/state";

test.beforeAll(async () => {
  await startHelper();
});

test.beforeEach(async () => {
  await resetState();
});

test("changing the TLD renames every hostname and re-pushes the desired state", async ({
  page,
  request,
}) => {
  for (const [name, port] of [
    ["shop", 3000],
    ["api", 4000],
  ] as const) {
    expect((await request.post("/api/aliases", { data: { name, port } })).status()).toBe(201);
  }
  await waitForApply((req) => req.routes.length === 2);
  expect(managedHostnames()).toEqual(["api.local", "shop.local"]);

  await page.goto("/settings");
  await page.getByTestId("settings-tld-input").fill("test");

  // Nothing is applied until the pending bar is used — that is the page's contract.
  const pending = page.getByTestId("settings-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("shop.local");
  await expect(pending).toContainText("shop.test");
  expect(managedHostnames()).toEqual(["api.local", "shop.local"]);

  await page.getByTestId("settings-apply").click();

  // A TLD change renames every hostname at once, so it asks first.
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Rename every hostname?");
  await dialog.getByTestId("confirm-accept").click();

  await expect(page.getByTestId("settings-receipt")).toBeVisible();
  await expect(page.getByTestId("settings-pending")).toHaveCount(0);
  await expect(page.getByTestId("settings-tld-input")).toHaveValue("test");

  const applied = await waitForApply((req) =>
    req.routes.length === 2 && req.routes.every((route) => route.host.endsWith(".test")),
  );
  expect(applied.routes.map((route) => route.host).sort()).toEqual(["api.test", "shop.test"]);

  await expect.poll(managedHostnames).toEqual(["api.test", "shop.test"]);
  const hosts = readHostsFile();
  expect(hosts).not.toContain("shop.local");
  expect(hosts).toContain("# Host Database");

  // Every hostname in the UI re-renders with the new suffix.
  await page.getByTestId("nav-aliases").click();
  await expect(page.locator('[data-testid="alias-row"]')).toHaveCount(2);
  // The status strip reads /api/status on its own slow poll, so it is only
  // guaranteed current after a real page load.
  await page.reload();
  await expect(page.getByTestId("status-strip")).toContainText(".test");
  for (const hostname of ["shop.test", "api.test"]) {
    await expect(page.locator(`[data-testid="alias-row"][data-alias="${hostname}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-testid="alias-row"][data-alias$=".local"]')).toHaveCount(0);

  const settings = (await (await request.get("/api/settings")).json()) as {
    settings: { tld: string };
  };
  expect(settings.settings.tld).toBe("test");
});

test("an invalid TLD blocks apply and changes nothing", async ({ page, request }) => {
  expect((await request.post("/api/aliases", { data: { name: "shop", port: 3000 } })).status()).toBe(
    201,
  );
  await waitForApply((req) => req.routes.length === 1);

  await page.goto("/settings");
  await page.getByTestId("settings-tld-input").fill("not a tld");

  await expect(page.getByTestId("settings-pending")).toHaveCount(0);
  await expect(page.locator("body")).toContainText("Use only a-z, 0-9 and hyphens");
  expect(managedHostnames()).toEqual(["shop.local"]);
});
