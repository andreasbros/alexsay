import { type Page, request } from "@playwright/test";
import { bypassHeaders } from "../playwright.config";
import { apiSession, env, expect, openSection, test } from "./helpers";

/** With email sign-in on, the page offers only an address (the code makes the account); otherwise the password form. */
async function openRegister(page: Page): Promise<"email" | "password"> {
  await page.goto("/register");
  const email = page.getByLabel("Email");
  await expect(email.or(page.getByLabel("Username")).first()).toBeVisible();
  return (await email.isVisible()) ? "email" : "password";
}

test("a new account: by email when email sign-in is on, else with a username and password", async ({ page }) => {
  const username = `e2e-${Date.now().toString(36)}`;
  const admin = await apiSession(env.admin());
  try {
    if ((await openRegister(page)) === "email") {
      await expect(page.getByText(/the code we send makes your account/)).toBeVisible();
      await expect(page.getByLabel("Username")).toHaveCount(0);
      await expect(page.getByLabel("Repeat password")).toHaveCount(0);
      // No inbox to read here: the password route still exists for the API, which the admin can see.
      // Its own context: registering signs that context in as the new user
      const guest = await request.newContext({ baseURL: env.appUrl(), extraHTTPHeaders: bypassHeaders });
      try {
        const made = await guest.post("/api/session/register", { data: { username, password: "battery staple" } });
        expect(made.status()).toBe(201);
      } finally {
        await guest.dispose();
      }
    } else {
      await page.getByLabel("Username").fill(username);
      await page.getByLabel("Password", { exact: true }).fill("battery staple");
      await page.getByLabel("Repeat password").fill("battery staple");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
      await openSection(page, "Devices");
      await expect(page.getByText("No speakers yet")).toBeVisible();
      // Plain users have no Users page
      await page.getByRole("button", { name: "Account" }).click();
      await expect(page.getByRole("menuitem", { name: "Users" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    const list = (await (await admin.get("/api/users")).json()) as { username: string; role: string }[];
    expect(list).toContainEqual(expect.objectContaining({ username, role: "user" }));
  } finally {
    await admin.delete(`/api/users/${username}`);
    await admin.dispose();
  }
});

test("a taken username is refused", async ({ page }) => {
  test.skip((await openRegister(page)) === "email", "no username form when email sign-in is on");
  await page.getByLabel("Username").fill(env.user().username);
  await page.getByLabel("Password", { exact: true }).fill("battery staple");
  await page.getByLabel("Repeat password").fill("battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("That username is taken.")).toBeVisible();
});
