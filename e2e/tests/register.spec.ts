import { apiSession, env, expect, test } from "./helpers";

test("anyone can register with a username and password, and the admin sees them", async ({ page }) => {
  const username = `e2e-${Date.now().toString(36)}`;
  await page.goto("/register");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill("battery staple");
  await page.getByLabel("Repeat password").fill("battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await expect(page.getByText("No speakers yet")).toBeVisible();

  // Plain users have no Users page
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("menuitem", { name: "Users" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const admin = await apiSession(env.admin());
  try {
    const list = (await (await admin.get("/api/users")).json()) as { username: string; role: string }[];
    expect(list).toContainEqual(expect.objectContaining({ username, role: "user" }));
  } finally {
    await admin.delete(`/api/users/${username}`);
    await admin.dispose();
  }
});

test("a taken username is refused", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Username").fill(env.user().username);
  await page.getByLabel("Password", { exact: true }).fill("battery staple");
  await page.getByLabel("Repeat password").fill("battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("That username is taken.")).toBeVisible();
});
