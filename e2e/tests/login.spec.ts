import { env, expect, login, test } from "./helpers";

// A made-up account each time, so repeated runs never lock anything out
test("rejects a wrong password", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill(`nobody-${Date.now().toString(36)}`);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong username or password.")).toBeVisible();
});

test("signs in and out", async ({ page }) => {
  await login(page, env.user());
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("login screen fits the viewport without scrolling", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - window.innerHeight,
    horizontal: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow).toEqual({ vertical: 0, horizontal: 0 });
});

test("switches between dark and light", async ({ page }) => {
  await login(page, env.user());
  const root = page.locator(".radix-themes").first();
  const before = await root.getAttribute("class");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect.poll(() => root.getAttribute("class")).not.toBe(before);
});

test("inputs are 16px on touch screens so the browser does not zoom", async ({ page, isMobile }) => {
  test.skip(!isMobile, "desktop browsers never zoom into inputs");
  await page.goto("/");
  const fontSize = await page.getByLabel("Username").evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
});
