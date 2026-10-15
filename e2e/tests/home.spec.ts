import { expect, login, openSection, openTab, test } from "./helpers";

test("a new account has its own home, which its owner can rename", async ({ page, account }) => {
  await login(page, account);
  await openTab(page, /Home/);
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await openSection(page, "People");
  await expect(page.getByRole("rowheader", { name: account.username })).toBeVisible();
  await expect(page.getByText("owner")).toBeVisible();
  // The name is renamed under Settings, after Email
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByLabel("Home name").fill("E2E flat");
  await page.getByRole("button", { name: "Rename" }).click();
  await openTab(page, /Home/);
  await expect(page.getByRole("heading", { name: "E2E flat" })).toBeVisible();
});
