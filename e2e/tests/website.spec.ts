import { env, expect, test } from "./helpers";

test("the website serves on both hosts and links to the app", async ({ page, request }) => {
  await page.goto(env.siteUrl());
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open the app/ }).first()).toHaveAttribute("href", /app\.alexsay\.com/);
  const apex = await request.get(env.siteUrl().replace("www.", ""), { maxRedirects: 0 });
  expect(apex.status()).toBe(200);
  const missing = await request.get(`${env.siteUrl()}/nowhere`);
  expect(missing.status()).toBe(404);
});
