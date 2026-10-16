import { Hono } from "hono";
import { changesNeedHomeAdmin, requireAdmin, requireUser } from "./auth";
import { assistantRoutes, lightwaveRoutes } from "./routes/assistant";
import { connectionRoutes, spotifyCallbackRoute } from "./routes/connections";
import { contactRoutes } from "./routes/contacts";
import { conversationRoutes, memoryRoutes } from "./routes/conversations";
import { deviceApiRoutes } from "./routes/device_api";
import { deviceRoutes } from "./routes/devices";
import { homeRoutes, inviteRoutes } from "./routes/home";
import { messageRoutes, notificationRoutes } from "./routes/messages";
import { musicRoutes } from "./routes/music";
import { openaiWebhookRoutes } from "./routes/openai_webhooks";
import { serverRoutes } from "./routes/server";
import { sessionRoutes } from "./routes/session";
import { alarmRoutes, skillRoutes } from "./routes/skills";
import { toolRoutes } from "./routes/tools";
import { twilioRoutes } from "./routes/twilio";
import { twilioConferenceRoute, twilioStreamRoute, twilioWebhookRoutes } from "./routes/twilio_webhooks";
import { userRoutes } from "./routes/users";
import { guardBundle } from "./static_assets";
import type { AppEnv } from "./types";
import { BadRequest } from "./validate";

export const app = new Hono<AppEnv>()
  .route("/v1/device", deviceApiRoutes)
  .route("/v1/twilio", twilioWebhookRoutes)
  .route("/v1/twilio", twilioConferenceRoute)
  .route("/v1/twilio", twilioStreamRoute)
  .route("/v1/openai", openaiWebhookRoutes)
  .route("/api/session", sessionRoutes)
  .route("/api/invites", inviteRoutes)
  .use("/api/home/*", requireUser)
  .use("/api/home", requireUser)
  .route("/api/home", homeRoutes)
  .use("/api/devices/*", requireUser, changesNeedHomeAdmin)
  .use("/api/devices", requireUser, changesNeedHomeAdmin)
  .route("/api/devices", deviceRoutes)
  .route("/api/connections", spotifyCallbackRoute)
  .use("/api/connections/*", requireUser, changesNeedHomeAdmin)
  .use("/api/connections", requireUser, changesNeedHomeAdmin)
  .route("/api/connections", connectionRoutes)
  .use("/api/assistant/*", requireUser)
  .route("/api/assistant", assistantRoutes)
  .use("/api/lightwave/*", requireUser)
  .route("/api/lightwave", lightwaveRoutes)
  .use("/api/conversations/*", requireUser)
  .use("/api/conversations", requireUser)
  .route("/api/conversations", conversationRoutes)
  .use("/api/memories/*", requireUser)
  .use("/api/memories", requireUser)
  .route("/api/memories", memoryRoutes)
  .use("/api/contacts/*", requireUser)
  .use("/api/contacts", requireUser)
  .route("/api/contacts", contactRoutes)
  .use("/api/messages/*", requireUser)
  .use("/api/messages", requireUser)
  .route("/api/messages", messageRoutes)
  .use("/api/music/*", requireUser)
  .use("/api/music", requireUser)
  .route("/api/music", musicRoutes)
  .use("/api/notifications/*", requireUser)
  .use("/api/notifications", requireUser)
  .route("/api/notifications", notificationRoutes)
  .use("/api/twilio/*", requireUser)
  .use("/api/twilio/numbers/*", changesNeedHomeAdmin)
  .route("/api/twilio", twilioRoutes)
  .use("/api/skills/*", requireUser)
  .use("/api/skills", requireUser)
  .route("/api/skills", skillRoutes)
  .use("/api/alarms/*", requireUser)
  .use("/api/alarms", requireUser)
  .route("/api/alarms", alarmRoutes)
  .use("/api/tools/*", requireUser)
  .route("/api/tools", toolRoutes)
  .use("/api/users/*", requireUser, requireAdmin)
  .use("/api/users", requireUser, requireAdmin)
  .route("/api/users", userRoutes)
  .use("/api/server/*", requireUser, requireAdmin)
  .use("/api/server", requireUser, requireAdmin)
  .route("/api/server", serverRoutes)
  .all("/api/*", (c) => c.json({ error: "not_found" }, 404))
  .all("/v1/*", (c) => c.json({ error: "not_found" }, 404))
  .all("*", async (c) => guardBundle(new URL(c.req.url).pathname, await c.env.ASSETS.fetch(c.req.raw)))
  .onError((err, c) => {
    if (err instanceof BadRequest) {
      return c.json({ error: "bad_request", issues: err.issues }, 400);
    }
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });
