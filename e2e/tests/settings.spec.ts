import { apiSession, expect, login, test } from "./helpers";

type Me = { locale: string; timezone: string; ai_log_access: boolean; ai_call_test: boolean };
type Session = { session: { delegation: { responses: { tools: { name: string }[] } } } };

test("where you are and the diagnostics switches are saved, and the assistant's tools follow them", async ({
  page,
  account,
  deviceId,
  request,
}) => {
  const user = await apiSession(account);
  await user.put("/api/connections/openai", { data: { api_key: "sk-e2e-not-a-real-key-0123456789" } });
  await user.post("/api/devices", { data: { id: deviceId } });
  const tools = async () => {
    const res = await request.get("/v1/device/session", { headers: { "x-device-id": deviceId } });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as Session).session.delegation.responses.tools.map((t) => t.name);
  };
  expect(await tools()).not.toContain("read_log");

  await login(page, account);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByLabel("Locale").click();
  await page.getByRole("option", { name: "English (United States)" }).click();
  await page.getByLabel("Time zone").click();
  await page.getByRole("option", { name: "America/New_York", exact: true }).click();
  await expect(page.getByLabel("Time zone")).toHaveText("America/New_York");
  await page.getByRole("switch", { name: "AI log access" }).click();
  await page.getByRole("switch", { name: "AI call test" }).click();
  await expect(page.getByRole("switch", { name: "AI call test" })).toBeChecked();

  await expect
    .poll(async () => (await (await user.get("/api/session/me")).json()) as Me)
    .toMatchObject({ locale: "en-US", timezone: "America/New_York", ai_log_access: true, ai_call_test: true });
  expect(await tools()).toContain("read_log");

  await page.reload();
  await expect(page.getByLabel("Locale")).toHaveText("English (United States)");
  await expect(page.getByRole("switch", { name: "AI log access" })).toBeChecked();
  await page.getByRole("switch", { name: "AI log access" }).click();
  await expect.poll(async () => ((await (await user.get("/api/session/me")).json()) as Me).ai_log_access).toBe(false);
  expect(await tools()).not.toContain("read_log");
  await user.dispose();
});
