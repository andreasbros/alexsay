import { apiSession, env, expect, login, test } from "./helpers";

test.afterEach(async ({ browser }) => {
  const user = await apiSession(browser, env.user());
  await user.delete("/api/connections/openai");
  await user.delete("/api/connections/lightwave");
  await user.dispose();
});

test("stores an OpenAI key, tests it, and the assistant becomes available", async ({ page }) => {
  await login(page, env.user());
  await page.getByRole("link", { name: /Assistant/ }).click();
  await expect(page.getByRole("button", { name: "Start talking" })).toBeDisabled();

  await page.getByRole("link", { name: /Connections/ }).click();
  await page.getByLabel("OpenAI API key").fill("sk-e2e-not-a-real-key-0123456789");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("connected").first()).toBeVisible();

  // The key is fake, so OpenAI refuses it; the app shows that refusal rather than hiding it
  await page.getByRole("button", { name: "Test" }).first().click();
  await expect(page.getByText(/\(401\)/)).toBeVisible();

  await page.getByRole("link", { name: /Assistant/ }).click();
  await expect(page.getByRole("button", { name: "Start talking" })).toBeEnabled();
});

test("a bad Lightwave token is reported when tested", async ({ page }) => {
  await login(page, env.user());
  await page.getByRole("link", { name: /Connections/ }).click();
  await page.getByLabel("Lightwave basic token").fill("e2e-basic-token-0123456789");
  await page.getByLabel("Lightwave refresh token").fill("e2e-refresh-token-0123456789");
  await page.getByRole("button", { name: "Save" }).last().click();
  await expect(page.getByText("connected").last()).toBeVisible();
  await expect(page.getByText(/Could not load lights/)).toBeVisible();
});
