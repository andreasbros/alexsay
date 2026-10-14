import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          SECRETS_KEY: "11".repeat(32),
          SMTP_HOST: "smtp.example.test",
          SMTP_PORT: "465",
          SMTP_USER: "api_token",
          SMTP_PASSWORD: "smtp-secret",
          EMAIL_FROM: "alexsay <hello@alexsay.test>",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
