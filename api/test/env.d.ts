import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** The relay standing in for GPT-Live's socket (test/fake_live.mjs). */
      FAKE_LIVE: Fetcher;
    }
  }
}
