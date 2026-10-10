import { apiSession, env, expect, login, test } from "./helpers";

test("starting a conversation with a bad key surfaces GPT-Live's refusal on the sphere screen", async ({
  page,
  browser,
}) => {
  const user = await apiSession(browser, env.user());
  await user.put("/api/connections/openai", { data: { api_key: "sk-e2e-not-a-real-key-0123456789" } });
  try {
    await login(page, env.user());
    await page.getByRole("link", { name: /Assistant/ }).click();
    await expect(page.getByRole("img", { name: /Assistant/ })).toBeVisible();
    await page.getByRole("button", { name: "Start talking" }).click();
    await expect(page.getByText("Error")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/provider: .+/)).toBeVisible();
  } finally {
    await user.delete("/api/connections/openai");
    await user.dispose();
  }
});
