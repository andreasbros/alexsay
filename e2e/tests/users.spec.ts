import { request } from "@playwright/test";
import { env, expect, login, test } from "./helpers";

test("the admin promotes, demotes and removes a user, who can then no longer sign in", async ({ page, account }) => {
  await login(page, env.admin());
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Users" }).click();
  const role = page.getByLabel(`Role of ${account.username}`);
  await expect(role).toHaveText("user");
  await role.click();
  await page.getByRole("option", { name: "admin" }).click();
  await expect(role).toHaveText("admin");
  await page.reload();
  await expect(page.getByLabel(`Role of ${account.username}`)).toHaveText("admin");
  await page.getByLabel(`Role of ${account.username}`).click();
  await page.getByRole("option", { name: "user" }).click();
  await expect(page.getByLabel(`Role of ${account.username}`)).toHaveText("user");

  await page
    .getByRole("row", { name: new RegExp(account.username) })
    .getByRole("button", { name: "Remove" })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("row", { name: new RegExp(account.username) })).toHaveCount(0);

  const context = await request.newContext({ baseURL: env.appUrl() });
  expect((await context.post("/api/session/login", { data: account })).status()).toBe(401);
  await context.dispose();
});
