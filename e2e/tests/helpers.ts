import { type APIRequestContext, test as base, expect, type Page, request } from "@playwright/test";

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

export async function login(page: Page, account: Account): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
}

/** Signs in through the API only, for cleanup and setup calls that need no browser; dispose it when done. */
export async function apiSession(account: Account): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: env.appUrl() });
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
export async function addDevice(page: Page, id: string, name = ""): Promise<void> {
  await page.getByRole("button", { name: "Add device" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("UUID").fill(id);
  if (name) {
    await dialog.getByLabel("Name").fill(name);
  }
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
 * `account`: a freshly registered user, so parallel tests never share connections; removed afterwards.
 */
export const test = base.extend<{ deviceId: string; account: Account }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take a destructured first argument
  deviceId: async ({}, use) => {
    const id = crypto.randomUUID();
    await use(id);
    const admin = await apiSession(env.admin());
    await admin.delete(`/api/devices/${id}`);
    await admin.dispose();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take a destructured first argument
  account: async ({}, use) => {
    const account = { username: `e2e-${crypto.randomUUID().slice(0, 8)}`, password: crypto.randomUUID() };
    const context = await request.newContext({ baseURL: env.appUrl() });
    const res = await context.post("/api/session/register", { data: account });
    await context.dispose();
    if (res.status() !== 201) {
      throw new Error(`register failed: ${res.status()}`);
    }
    await use(account);
    const admin = await apiSession(env.admin());
    await admin.delete(`/api/users/${account.username}`);
    await admin.dispose();
  },
});

export { expect };
