import { type APIRequestContext, type Browser, test as base, expect, type Page } from "@playwright/test";

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

/** Signs in through the API only, for cleanup and setup calls that need no browser. */
export async function apiSession(browser: Browser, account: Account): Promise<APIRequestContext> {
  const context = await browser.newContext();
  const res = await context.request.post("/api/session/login", { data: account });
  if (!res.ok()) {
    throw new Error(`api login failed for ${account.username}: ${res.status()}`);
  }
  return context.request;
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

/** A device id unique to this test run; deleted again by an admin after the test. */
export const test = base.extend<{ deviceId: string }>({
  deviceId: async ({ browser }, use) => {
    const id = crypto.randomUUID();
    await use(id);
    const admin = await apiSession(browser, env.admin());
    await admin.delete(`/api/devices/${id}`);
    await admin.dispose();
  },
});

export { expect };
