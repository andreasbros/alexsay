import { Hono } from "hono";
import { openaiConnection, twilioConnection } from "../connections";
import { devices } from "../db";
import * as schemas from "../schemas";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/**
 * What a speaker calls. Its UUID is both its identity and its secret: whoever adds that UUID
 * in the app owns the speaker, and the speaker then receives the owner's assistant credentials.
 */
export const deviceApiRoutes = new Hono<AppEnv>()
  .get("/health", (c) => c.json({ ok: true, time: Date.now() }))
  .post("/heartbeat", async (c) => {
    const parsed = schemas.deviceId.safeParse(c.req.header("x-device-id") ?? "");
    if (!parsed.success) {
      return c.json({ error: "device_id" }, 400);
    }
    const id = parsed.data;
    const report = await jsonBody(c, schemas.heartbeat);
    const now = Date.now();
    const meta = JSON.stringify({
      uptime_s: report.uptime_s ?? null,
      ip: c.req.header("cf-connecting-ip") ?? report.ip ?? null,
      country: c.req.raw.cf?.country ?? null,
    });
    await devices.touch(c.env.DB, id, now, report.firmware ?? null, meta);
    const row = await devices.get(c.env.DB, id);
    if (!row?.owner) {
      return c.json({ claimed: false, time: now, poll_s: 30 });
    }
    const [connection, twilio] = await Promise.all([openaiConnection(c, row.owner), twilioConnection(c, row.owner)]);
    const telephony =
      twilio?.settings.sip_domain && twilio.settings.from_number
        ? { sip_domain: twilio.settings.sip_domain, sip_username: id, from_number: twilio.settings.from_number }
        : null;
    return c.json({
      claimed: true,
      name: row.name,
      time: now,
      poll_s: 60,
      assistant: connection ? { provider: "openai", api_key: connection.apiKey, ...connection.settings } : null,
      telephony,
    });
  });
