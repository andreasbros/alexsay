import { app } from "./app";

export { CallAgent } from "./call_agent";
export { LineBridge } from "./line_bridge";
export { Scheduler } from "./scheduler";

import { purgeExpired } from "./db";

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await purgeExpired(env.DB, Date.now());
  },
} satisfies ExportedHandler<Env>;
