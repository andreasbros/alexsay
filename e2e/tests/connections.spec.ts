import { expect, login, openTab, test } from "./helpers";

test("stores an OpenAI key, tests it, and the assistant becomes available", async ({ page, account }) => {
  await login(page, account);
  await openTab(page, /Assistant/);
  await expect(page.getByRole("button", { name: "Start talking" })).toBeDisabled();

  await openTab(page, /Home/);
  await page.getByLabel("OpenAI API key").fill("sk-e2e-not-a-real-key-0123456789");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("connected").first()).toBeVisible();

  // The key is fake, so OpenAI refuses it; the app shows that refusal rather than hiding it
  await page.getByRole("button", { name: "Test" }).first().click();
  await expect(page.getByText(/Incorrect API key/)).toBeVisible();

  await openTab(page, /Assistant/);
  await expect(page.getByRole("button", { name: "Start talking" })).toBeEnabled();

  // Settings change without typing the key again
  await openTab(page, /Home/);
  await page.getByRole("button", { name: "Change" }).click();
  await page.getByLabel("Backend model").fill("gpt-6.1-sol");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText(/via gpt-6\.1-sol/)).toBeVisible();
});

test("bad Lightwave tokens are refused when saved", async ({ page, account }) => {
  await login(page, account);
  await openTab(page, /Home/);
  await page.getByLabel("Lightwave basic token").fill("e2e-basic-token-0123456789");
  await page.getByLabel("Lightwave refresh token").fill("e2e-refresh-token-0123456789");
  await page.getByRole("button", { name: "Save" }).nth(1).click();
  await expect(page.getByText(/Lightwave refused the tokens/)).toBeVisible();
  await expect(page.getByText("not connected")).toHaveCount(3);
});

test("bad Twilio credentials are refused when saved", async ({ page, account }) => {
  await login(page, account);
  await openTab(page, /Home/);
  await page.getByLabel("Twilio account SID").fill("AC00000000000000000000000000000000");
  await page.getByLabel("Twilio auth token").fill("00000000000000000000000000000000");
  await page.getByRole("button", { name: "Save" }).last().click();
  await expect(page.getByText(/Twilio refused the credentials/)).toBeVisible();
  await expect(page.getByText("not connected")).toHaveCount(3);
});

test("each connection has a Help dialog with the steps to get its keys", async ({ page, account }) => {
  await login(page, account);
  await openTab(page, /Home/);
  await page.getByRole("button", { name: "Help" }).first().click();
  await expect(page.getByRole("heading", { name: "Get an OpenAI API key" })).toBeVisible();
  await expect(page.getByText(/Create new secret key/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "How to enable" }).click();
  await expect(page.getByRole("heading", { name: /Let the assistant join phone calls/ })).toBeVisible();
  await expect(page.getByText(/realtime\.call\.incoming/).first()).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Help" }).nth(1).click();
  await expect(page.getByRole("heading", { name: "Get your Lightwave API tokens" })).toBeVisible();
  await expect(page.getByText(/API Integration/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Help" }).last().click();
  await expect(page.getByRole("heading", { name: "Connect Twilio" })).toBeVisible();
  await expect(page.getByText(/Account SID/)).toBeVisible();
});
