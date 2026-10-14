import { env, expect, login, openPasswordForm, passwordField, signInScreen, test } from "./helpers";

// A made-up account each time, so repeated runs never lock anything out
test("rejects a wrong password", async ({ page }) => {
  await page.goto("/");
  await openPasswordForm(page);
  await page.getByLabel("Username").fill(`nobody-${Date.now().toString(36)}`);
  await passwordField(page).fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong username or password.")).toBeVisible();
});

test("signs in and out", async ({ page }) => {
  await login(page, env.user());
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(signInScreen(page)).toBeVisible();
});

test("login screen fits the viewport without scrolling", async ({ page }) => {
  await page.goto("/");
  await expect(signInScreen(page)).toBeVisible();
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
  await openPasswordForm(page);
  const username = page.getByLabel("Username");
  await expect(username).toBeVisible();
  const fontSize = await username.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
});
