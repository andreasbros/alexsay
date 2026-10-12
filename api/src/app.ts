import { Hono } from "hono";
import { requireAdmin, requireUser } from "./auth";
import { assistantRoutes, lightwaveRoutes } from "./routes/assistant";
import { connectionRoutes } from "./routes/connections";
import { contactRoutes } from "./routes/contacts";
import { conversationRoutes, memoryRoutes } from "./routes/conversations";
import { deviceApiRoutes } from "./routes/device_api";
import { deviceRoutes } from "./routes/devices";
import { openaiWebhookRoutes } from "./routes/openai_webhooks";
import { sessionRoutes } from "./routes/session";
import { toolRoutes } from "./routes/tools";
import { twilioRoutes } from "./routes/twilio";
import { twilioConferenceRoute, twilioStreamRoute, twilioWebhookRoutes } from "./routes/twilio_webhooks";
import { userRoutes } from "./routes/users";
import type { AppEnv } from "./types";
import { BadRequest } from "./validate";

export const app = new Hono<AppEnv>()
  .route("/v1/device", deviceApiRoutes)
  .route("/v1/twilio", twilioWebhookRoutes)
  .route("/v1/twilio", twilioConferenceRoute)
  .route("/v1/twilio", twilioStreamRoute)
  .route("/v1/openai", openaiWebhookRoutes)
  .route("/api/session", sessionRoutes)
  .use("/api/devices/*", requireUser)
  .use("/api/devices", requireUser)
  .route("/api/devices", deviceRoutes)
  .use("/api/connections/*", requireUser)
  .use("/api/connections", requireUser)
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
  .use("/api/twilio/*", requireUser)
  .route("/api/twilio", twilioRoutes)
  .use("/api/tools/*", requireUser)
  .route("/api/tools", toolRoutes)
  .use("/api/users/*", requireUser, requireAdmin)
  .use("/api/users", requireUser, requireAdmin)
  .route("/api/users", userRoutes)
  .all("/api/*", (c) => c.json({ error: "not_found" }, 404))
  .all("/v1/*", (c) => c.json({ error: "not_found" }, 404))
  .all("*", (c) => c.env.ASSETS.fetch(c.req.raw))
  .onError((err, c) => {
    if (err instanceof BadRequest) {
      return c.json({ error: "bad_request", issues: err.issues }, 400);
    }
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });
