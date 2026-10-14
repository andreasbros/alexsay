import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_APP_URL ?? "https://app.alexsay.com";
// A managed Turnstile widget never passes for an automated browser: the server lets this header through instead
export const bypassHeaders: Record<string, string> = process.env.TURNSTILE_BYPASS
  ? { "x-turnstile-bypass": process.env.TURNSTILE_BYPASS }
  : {};

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  retries: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: {
    baseURL,
    extraHTTPHeaders: bypassHeaders,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  projects: [
    { name: "desktop", use: devices["Desktop Chrome"] },
    { name: "mobile", use: { ...devices["Pixel 7"], permissions: ["microphone"] }, testMatch: /login\.spec\.ts/ },
  ],
});
