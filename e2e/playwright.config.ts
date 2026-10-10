import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_APP_URL ?? "https://app.alexsay.com";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  retries: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: {
    baseURL,
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
