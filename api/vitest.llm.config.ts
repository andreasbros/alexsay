import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The real model against the real tool code: `just e2e-llm`, with E2E_OPENAI_API_KEY in .env
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          SECRETS_KEY: "11".repeat(32),
          E2E_OPENAI_API_KEY: process.env.E2E_OPENAI_API_KEY ?? "",
        },
      },
    }),
  ],
  test: { include: ["test-llm/**/*.llm.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 180_000 },
}));
