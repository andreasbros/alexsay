import type { Context } from "hono";
import type { AppEnv, ToolContext, VoiceClient } from "./types";

/** What a tool needs from the request: bindings, who is asking, where the app lives, how they take calls. */
export const toolContext = (c: Context<AppEnv>, voice: VoiceClient = "mobile"): ToolContext => ({
  env: c.env,
  user: c.get("user"),
  origin: new URL(c.req.url).origin,
  voice,
});
