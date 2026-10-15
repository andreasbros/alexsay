import { type APIRequestContext, test as base, expect, type Page, request } from "@playwright/test";
import { bypassHeaders } from "../playwright.config";

export type Account = { username: string; password: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set: copy .env.example to .env and run just e2e-users for the test accounts`);
  }
  return value;
}

export const env = {
  appUrl: () => process.env.E2E_APP_URL ?? "https://app.alexsay.com",
  siteUrl: () => process.env.E2E_SITE_URL ?? "https://www.alexsay.com",
  admin: (): Account => ({ username: required("E2E_ADMIN_USERNAME"), password: required("E2E_ADMIN_PASSWORD") }),
  user: (): Account => ({ username: required("E2E_USER_USERNAME"), password: required("E2E_USER_PASSWORD") }),
};

/** In GitHub Actions, keeps a generated credential or speaker id out of the logs. */
export function mask(value: string): void {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::add-mask::${value}`);
  }
}

/** The sign-in screen, with or without email sign-in on the server. */
export const signInScreen = (page: Page) =>
  page
    .getByLabel("Username")
    .or(page.getByRole("tab", { name: /Password/ }))
    .first();

/** Opens the username and password form: with email sign-in on, it is the second tab. */
export async function openPasswordForm(page: Page): Promise<void> {
  await expect(signInScreen(page)).toBeVisible();
  const passwordTab = page.getByRole("tab", { name: /Password/ });
  if (await passwordTab.isVisible()) {
    await passwordTab.click();
  }
}

/** The password field only: the Password tab panel carries the same label. */
export const passwordField = (page: Page) => page.getByRole("textbox", { name: "Password" });

export async function login(page: Page, account: Account): Promise<void> {
  await page.goto("/");
  await openPasswordForm(page);
  await page.getByLabel("Username").fill(account.username);
  await passwordField(page).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
}

/** Signs in through the API only, for cleanup and setup calls that need no browser; dispose it when done. */
export async function apiSession(account: Account): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: env.appUrl(), extraHTTPHeaders: bypassHeaders });
  const res = await context.post("/api/session/login", { data: account });
  if (!res.ok()) {
    await context.dispose();
    throw new Error(`api login failed for ${account.username}: ${res.status()}`);
  }
  return context;
}

/** Opens one of the app's tabs; the tab bar is a navigation landmark, which keeps page links out of it. */
export async function openTab(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("navigation").getByRole("link", { name }).first().click();
}

/** Adds a speaker through the dialog and waits for it to appear in the table. */
export async function addDevice(page: Page, id: string, name = "Test speaker"): Promise<void> {
  await page.getByRole("button", { name: "Add device" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("UUID").fill(id);
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(id)).toBeVisible();
}

/** What the Rust daemon sends: the same call, so the deployed API is exercised exactly as a speaker would. */
export function heartbeat(request: APIRequestContext, deviceId: string, report: Record<string, unknown> = {}) {
  return request.post(`${env.appUrl()}/v1/device/heartbeat`, {
    headers: { "x-device-id": deviceId },
    data: { firmware: "e2e", uptime_s: 1, ...report },
  });
}

/**
 * `deviceId`: a speaker id unique to this test, deleted by an admin afterwards.
 * `account`: a fresh user made by the admin, so parallel tests never share connections; removed afterwards.
 */
export const test = base.extend<{ deviceId: string; account: Account }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take a destructured first argument
  deviceId: async ({}, use) => {
    const id = crypto.randomUUID();
    mask(id);
    await use(id);
    const admin = await apiSession(env.admin());
    await admin.delete(`/api/devices/${id}`);
    await admin.dispose();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take a destructured first argument
  account: async ({}, use) => {
    const account = { username: `e2e-${crypto.randomUUID().slice(0, 8)}`, password: crypto.randomUUID() };
    mask(account.password);
    // Made by the admin: public registration is limited per address, and a few runs an hour would use it up
    const admin = await apiSession(env.admin());
    const res = await admin.post("/api/users", { data: account });
    if (res.status() !== 201) {
      await admin.dispose();
      throw new Error(`creating the test account failed: ${res.status()}`);
    }
    await use(account);
    await admin.delete(`/api/users/${account.username}`);
    await admin.dispose();
  },
});

export { expect };
