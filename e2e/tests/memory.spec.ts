import { apiSession, expect, login, openTab, test } from "./helpers";

test("adds, recategorises and forgets a memory", async ({ page, account }) => {
  const fact = `The e2e hall light stays on at night ${Date.now()}`;
  await login(page, account);
  await openTab(page, /Memory/);
  await page.getByRole("button", { name: "Add memory" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Memory").fill(fact);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(fact)).toBeVisible();

  await page.getByLabel(`Category of ${fact}`).click();
  await page.getByRole("option", { name: "home" }).click();
  await expect(page.getByLabel(`Category of ${fact}`)).toHaveText("home");

  const user = await apiSession(account);
  const stored = (await (await user.get("/api/memories")).json()) as { content: string; category: string }[];
  expect(stored).toContainEqual(expect.objectContaining({ content: fact, category: "home" }));
  await user.dispose();

  await page.reload();
  await expect(page.getByText(fact)).toBeVisible();
  await page.getByRole("button", { name: "Forget" }).click();
  await expect(page.getByText(fact)).toHaveCount(0);
});

test("a speaker's conversation and what it remembered show up in Memory", async ({
  page,
  account,
  deviceId,
  request,
}) => {
  const user = await apiSession(account);
  expect((await user.post("/api/devices", { data: { id: deviceId, name: "e2e kitchen" } })).status()).toBe(201);
  await user.dispose();
  const speaker = { "x-device-id": deviceId };

  // What the speaker sends during a conversation: a tool call, its turns, then the end
  const remembered = await request.post("/v1/device/tools/call", {
    headers: speaker,
    data: { name: "remember", arguments: { category: "people", content: "Maria's sister is called Ana" } },
  });
  expect(remembered.ok()).toBe(true);
  const started = await request.post("/v1/device/conversations", { headers: speaker, data: {} });
  expect(started.ok()).toBe(true);
  const { id } = (await started.json()) as { id: string };
  const now = Date.now();
  const turns = [
    { at: now, role: "user", text: "Remember that my sister is called Ana" },
    { at: now + 1000, role: "assistant", text: "Got it, your sister is Ana." },
  ];
  expect((await request.post(`/v1/device/conversations/${id}/turns`, { headers: speaker, data: { turns } })).ok()).toBe(
    true,
  );
  expect((await request.post(`/v1/device/conversations/${id}/end`, { headers: speaker, data: {} })).ok()).toBe(true);

  await login(page, account);
  await openTab(page, /Memory/);
  await expect(page.getByText("Maria's sister is called Ana")).toBeVisible();

  await page.getByRole("radio", { name: "Conversations" }).click();
  const card = page.locator(".rt-Card", { hasText: "2 turns" });
  await expect(card.getByText("device")).toBeVisible();
  await card.getByRole("button", { name: "Show transcript" }).click();
  await expect(card.getByText("Got it, your sister is Ana.")).toBeVisible();

  await page.getByLabel("Search conversations").fill("sister");
  await expect(page.locator(".rt-Card", { hasText: "2 turns" })).toHaveCount(1);
  await page.getByLabel("Search conversations").fill("zebra crossing");
  await expect(page.getByText("No conversations match.")).toBeVisible();

  await page.getByLabel("Search conversations").fill("");
  await page.locator(".rt-Card", { hasText: "2 turns" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No conversations yet.")).toBeVisible();
});
