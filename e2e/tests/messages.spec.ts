import { env, expect, login, openTab, test } from "./helpers";

test("the Messages tab lists notifications, texts and calls", async ({ page }) => {
  await login(page, env.user());
  await openTab(page, /Messages/);
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  for (const name of [/^Notifications/, /^SMS/, /^Calls/]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }
  await page.getByRole("tab", { name: /^Calls/ }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});
