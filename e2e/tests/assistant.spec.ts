import { apiSession, expect, login, openTab, test } from "./helpers";

test("starting a conversation with a bad key surfaces GPT-Live's refusal on the sphere screen", async ({
  page,
  account,
}) => {
  const user = await apiSession(account);
  await user.put("/api/connections/openai", { data: { api_key: "sk-e2e-not-a-real-key-0123456789" } });
  await user.dispose();
  await login(page, account);
  await openTab(page, /Assistant/);
  await expect(page.getByRole("img", { name: /Assistant/ })).toBeVisible();
  await page.getByRole("button", { name: "Start talking" }).click();
  await expect(page.getByText("Error")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/provider: .+/).first()).toBeVisible();
});
