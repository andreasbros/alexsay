import { expect, login, test } from "./helpers";

test("stores an OpenAI key, tests it, and the assistant becomes available", async ({ page, account }) => {
  await login(page, account);
  await page.getByRole("link", { name: /Assistant/ }).click();
  await expect(page.getByRole("button", { name: "Start talking" })).toBeDisabled();

  await page.getByRole("link", { name: /Connections/ }).click();
  await page.getByLabel("OpenAI API key").fill("sk-e2e-not-a-real-key-0123456789");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("connected").first()).toBeVisible();

  // The key is fake, so OpenAI refuses it; the app shows that refusal rather than hiding it
  await page.getByRole("button", { name: "Test" }).first().click();
  await expect(page.getByText(/Incorrect API key/)).toBeVisible();

  await page.getByRole("link", { name: /Assistant/ }).click();
  await expect(page.getByRole("button", { name: "Start talking" })).toBeEnabled();
});

test("a bad Lightwave token is reported when tested", async ({ page, account }) => {
  await login(page, account);
  await page.getByRole("link", { name: /Connections/ }).click();
  await page.getByLabel("Lightwave basic token").fill("e2e-basic-token-0123456789");
  await page.getByLabel("Lightwave refresh token").fill("e2e-refresh-token-0123456789");
  await page.getByRole("button", { name: "Save" }).last().click();
  await expect(page.getByText("connected").last()).toBeVisible();
  await expect(page.getByText(/Could not load lights/)).toBeVisible();
});

test("each connection has a Help dialog with the steps to get its keys", async ({ page, account }) => {
  await login(page, account);
  await page.getByRole("link", { name: /Connections/ }).click();
  await page.getByRole("button", { name: "Help" }).first().click();
  await expect(page.getByRole("heading", { name: "Get an OpenAI API key" })).toBeVisible();
  await expect(page.getByText(/Create new secret key/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Help" }).last().click();
  await expect(page.getByRole("heading", { name: "Get your Lightwave API tokens" })).toBeVisible();
  await expect(page.getByText(/API Integration/)).toBeVisible();
});
