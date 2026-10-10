import { app } from "./app";
import { purgeExpired } from "./db";

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await purgeExpired(env.DB, Date.now());
  },
} satisfies ExportedHandler<Env>;
