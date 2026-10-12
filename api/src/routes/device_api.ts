import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { addTurns, endConversation, runToolFor, sessionFor, startConversation } from "../assistant_api";
import { openaiConnection, twilioConnection } from "../connections";
import { devices, users } from "../db";
import { serverOrigin } from "../origin";
import * as schemas from "../schemas";
import { callReport, speakerOnline, TelephonyError } from "../telephony";
import type { AppEnv } from "../types";
import { jsonBody, parse } from "../validate";

/** A claimed speaker acts as its owner: the UUID in the header is the credential. */
const requireClaimedDevice = createMiddleware<AppEnv>(async (c, next) => {
  const parsed = schemas.deviceId.safeParse(c.req.header("x-device-id") ?? "");
  if (!parsed.success) {
    return c.json({ error: "device_id" }, 400);
  }
  const row = await devices.get(c.env.DB, parsed.data);
  const owner = row?.owner ? await users.get(c.env.DB, row.owner) : null;
  if (!row?.owner || !owner) {
    return c.json({ error: "unclaimed" }, 403);
  }
  c.set("user", { username: owner.username, role: owner.role });
  c.set("device", { id: row.id, name: row.name });
  await next();
});

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
    const [connection, twilio, account] = await Promise.all([
      openaiConnection(c, row.owner),
      twilioConnection(c, row.owner),
      users.locale(c.env.DB, row.owner),
    ]);
    const telephony =
      twilio?.settings.sip_domain && twilio.settings.from_number
        ? { sip_domain: twilio.settings.sip_domain, sip_username: id, from_number: twilio.settings.from_number }
        : null;
    return c.json({
      claimed: true,
      name: row.name,
      time: now,
      poll_s: 60,
      assistant: connection
        ? { provider: "openai", api_key: connection.apiKey, base_url: c.env.OPENAI_BASE_URL, ...connection.settings }
        : null,
      telephony,
      account,
    });
  })
  .use("/session", requireClaimedDevice)
  .use("/tools/*", requireClaimedDevice)
  .use("/conversations", requireClaimedDevice)
  .use("/conversations/*", requireClaimedDevice)
  .use("/line", requireClaimedDevice)
  .use("/line/*", requireClaimedDevice)
  .use("/conferences/*", requireClaimedDevice)
  /** The speaker's phone line: a WebSocket held open while it runs, so calls can open on it. */
  .get("/line", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected a websocket" }, 426);
    }
    const id = c.get("device").id;
    const bridge = c.env.LINE_BRIDGE.get(c.env.LINE_BRIDGE.idFromName(id));
    return bridge.fetch("https://line/device", { headers: { upgrade: "websocket" } });
  })
  .get("/line/status", async (c) => c.json({ online: await speakerOnline(c, c.get("device").id) }))
  .get("/conferences/:name/report", async (c) => {
    const name = parse(schemas.conferenceName, c.req.param("name"));
    try {
      return c.json(await callReport(c, c.get("user").username, name));
    } catch (err) {
      if (err instanceof TelephonyError) {
        return c.json({ error: err.code, detail: err.message }, 412);
      }
      throw err;
    }
  })
  /** The GPT-Live session to start, built exactly as for the web page, with the owner's key for the socket. */
  .get("/session", async (c) => {
    const built = await sessionFor({ env: c.env, user: c.get("user"), origin: serverOrigin(c) });
    if (!built) {
      return c.json({ error: "no_openai_connection" }, 412);
    }
    return c.json({
      api_key: built.apiKey,
      base_url: c.env.OPENAI_BASE_URL,
      session: built.session,
      device: c.get("device"),
    });
  })
  .post("/tools/call", async (c) => {
    const { name, arguments: args, conversation_id } = await jsonBody(c, schemas.toolCall);
    const device = c.get("device").id;
    // With its line up the speaker takes calls itself; otherwise they ring the owner's mobile
    const voice = (await speakerOnline(c, device)) ? ("speaker" as const) : ("mobile" as const);
    const context = { env: c.env, user: c.get("user"), origin: serverOrigin(c), voice, device };
    return c.json({ output: await runToolFor(context, name, args, conversation_id ?? null) });
  })
  .post("/conversations", async (c) => {
    const id = await startConversation(c.env, c.get("user").username, "device", c.get("device").id);
    return c.json({ id }, 201);
  })
  .post("/conversations/:id/turns", async (c) => {
    const id = parse(schemas.memoryId, c.req.param("id"));
    const { turns } = await jsonBody(c, schemas.addTurns);
    const ok = await addTurns(c.env, c.get("user").username, id, turns);
    return ok ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  })
  .post("/conversations/:id/end", async (c) => {
    const id = parse(schemas.memoryId, c.req.param("id"));
    const ok = await endConversation(c.env, c.executionCtx, c.get("user").username, id);
    return ok ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });
