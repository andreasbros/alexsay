import { env, expect, login, openTab, test } from "./helpers";

test("the admin reaches the Users page and sees roles", async ({ page }) => {
  await login(page, env.admin());
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Users" }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: env.admin().username })).toBeVisible();
  await expect(page.getByRole("combobox", { name: `Role of ${env.user().username}` })).toBeVisible();
});

test("the signed-in pages fit the viewport width", async ({ page }) => {
  await login(page, env.admin());
  const horizontalOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await horizontalOverflow()).toBe(0);
  for (const name of [/Assistant/, /Memory/, /Skills/, /Home/]) {
    await openTab(page, name);
    expect(await horizontalOverflow()).toBe(0);
  }
});

test("only the header's border runs under the menu", async ({ page }) => {
  await login(page, env.user());
  const shadows = await page
    .locator(".app-tabs.rt-BaseTabList, .app-tabs .rt-BaseTabList")
    .evaluateAll((lists) => lists.map((list) => getComputedStyle(list).boxShadow));
  expect(shadows.length).toBeGreaterThan(0);
  expect(new Set(shadows)).toEqual(new Set(["none"]));
});
