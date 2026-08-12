import { expect, test } from "@playwright/test";
import { readJournal, startHelper, waitForApply } from "../fixtures/helper-control";
import { managedHostnames, readConfig, resetState } from "../fixtures/state";

test.beforeAll(async () => {
  await startHelper();
});

test.beforeEach(async () => {
  await resetState();
});

/** One existing alias, so the duplicate-name rule has something to collide with. */
async function seedShop(request: import("@playwright/test").APIRequestContext): Promise<void> {
  const res = await request.post("/api/aliases", { data: { name: "shop", port: 3000 } });
  expect(res.status()).toBe(201);
  await waitForApply((req) => req.routes.some((route) => route.host === "shop.local"));
}

test("every rejection is shown inline, before submit, and nothing is persisted", async ({
  page,
  request,
}) => {
  await seedShop(request);
  await page.goto("/");
  await expect(page.locator('[data-testid="alias-row"]')).toHaveCount(1);

  const form = page.getByTestId("alias-create-form");
  const name = page.getByTestId("alias-name-input");
  const port = page.getByTestId("alias-port-input");
  const submit = page.getByTestId("alias-submit");

  await name.fill("My App!");
  await expect(form).toContainText("Use only a-z, 0-9 and hyphens");
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("localhost");
  await expect(form).toContainText("is reserved by the system and cannot be used");

  await name.fill("SHOP");
  await expect(form).toContainText('"shop" is already patched');

  await name.fill("-leading-hyphen");
  await expect(form).toContainText("a label cannot start or end with a hyphen");

  await name.fill("shop2");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");

  await port.fill("99999");
  await expect(form).toContainText("Must be between 1 and 65535");
  await port.fill("30 00");
  await expect(form).toContainText("Ports are digits only");

  // The submit button is a validation trigger, not a gate: it stays enabled and
  // pressing it must surface the error rather than send anything.
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(port).toBeFocused();
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await expect(page.locator('[data-testid="alias-row"]')).toHaveCount(1);

  // Same for a bad name with a perfectly good port.
  await port.fill("3001");
  await name.fill("bad name");
  await submit.click();
  await expect(name).toBeFocused();
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await expect(page.locator('[data-testid="alias-row"]')).toHaveCount(1);

  // Nothing reached the config, the helper or the hosts file.
  const aliases = (await (await request.get("/api/aliases")).json()) as { aliases: { name: string }[] };
  expect(aliases.aliases.map((alias) => alias.name)).toEqual(["shop"]);
  expect(readConfig()?.aliases.map((alias) => alias.name)).toEqual(["shop"]);
  expect(readJournal()).toHaveLength(1);
  expect(managedHostnames()).toEqual(["shop.local"]);
});

test("the server refuses what the form would have refused", async ({ request }) => {
  await seedShop(request);

  for (const [payload, field] of [
    [{ name: "shop", port: 4000 }, "name"],
    [{ name: "localhost", port: 4000 }, "name"],
    [{ name: "bad name", port: 4000 }, "name"],
    [{ name: "ok", port: 99999 }, "port"],
  ] as const) {
    const res = await request.post("/api/aliases", { data: payload });
    expect(res.status(), JSON.stringify(payload)).toBe(400);
    const body = (await res.json()) as { issues?: { field: string }[] };
    expect(body.issues?.map((issue) => issue.field)).toContain(field);
  }

  expect(readConfig()?.aliases.map((alias) => alias.name)).toEqual(["shop"]);
  expect(readJournal()).toHaveLength(1);
});
