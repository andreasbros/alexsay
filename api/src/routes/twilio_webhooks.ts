import type { Context } from "hono";
import { Hono } from "hono";
import { type TwilioConnection, twilioFromRow } from "../connections";
import { calls, connections, contacts, devices, messages } from "../db";
import { bareNumber, normalisePhone, WHATSAPP_PREFIX } from "../phone";
import { CLIENT_IDENTITY, validSignature } from "../providers/twilio";
import { guestAnswered, hostAnswered } from "../telephony";
import { dialOutTwiml, emptyTwiml, rejectTwiml, ringTwiml } from "../twiml";
import type { AppEnv } from "../types";

const SIP_USER = /^sip:([^@;]+)@/;

type Params = Record<string, string>;

interface Owner {
  username: string;
  connection: TwilioConnection;
}

/**
 * What Twilio calls us about: a call or message arriving on the user's number, a speaker dialling
 * out through the SIP domain, and status changes of calls we placed. Every request is checked
 * against the owning user's auth token before anything is stored.
 */
export const twilioWebhookRoutes = new Hono<AppEnv>()
  .post("/voice", async (c) => {
    const params = await form(c);
    const owner = await ownerOfNumber(c, params.To ?? "");
    if (!owner) {
      return xml(c, rejectTwiml("This number is not set up."), 404);
    }
    if (!(await signed(c, owner, params))) {
      return c.text("forbidden", 403);
    }
    const from = params.From ?? "";
    const { settings } = owner.connection;
    const speakers = settings.sip_domain
      ? (await devices.list(c.env.DB, owner.username)).map((d) => `sip:${d.id}@${settings.sip_domain}`)
      : [];
    // The user's own mobile cannot take a call it is making itself, so it is left out when it is the caller
    const mobile = settings.my_number && settings.my_number !== from ? settings.my_number : null;
    const rang = ["app", ...speakers.map(() => "speaker"), ...(mobile ? ["mobile"] : [])];
    const contact = await contacts.byPhone(c.env.DB, owner.username, from);
    const now = Date.now();
    await calls.create(c.env.DB, {
      username: owner.username,
      contact_id: contact?.id ?? null,
      direction: "in",
      kind: "call",
      phone: from,
      conference: null,
      brief: `rang: ${rang.join(", ")}`,
      sid: params.CallSid ?? null,
      status: params.CallStatus ?? "ringing",
      at: now,
    });
    await contacts.stamp(c.env.DB, owner.username, from, "last_called_at", now);
    return xml(c, ringTwiml(speakers, mobile, CLIENT_IDENTITY));
  })
  .post("/voice/outbound", async (c) => {
    const params = await form(c);
    const deviceId = SIP_USER.exec(params.From ?? "")?.[1] ?? "";
    const device = await devices.get(c.env.DB, deviceId);
    const row = device?.owner ? await connections.get(c.env.DB, device.owner, "twilio") : null;
    if (!device?.owner || !row) {
      return xml(c, rejectTwiml("This speaker is not set up for calls."), 404);
    }
    const owner = { username: device.owner, connection: await twilioFromRow(c, row) };
    if (!(await signed(c, owner, params))) {
      return c.text("forbidden", 403);
    }
    const dialled = SIP_USER.exec(params.To ?? "")?.[1] ?? "";
    const to = normalisePhone(decodeURIComponent(dialled), owner.connection.settings.country_code);
    if (!to || !owner.connection.settings.from_number) {
      return xml(c, rejectTwiml("That number cannot be dialled."));
    }
    const contact = await contacts.byPhone(c.env.DB, owner.username, to);
    const now = Date.now();
    await calls.create(c.env.DB, {
      username: owner.username,
      contact_id: contact?.id ?? null,
      direction: "out",
      kind: "call",
      phone: to,
      conference: null,
      sid: params.CallSid ?? null,
      status: params.CallStatus ?? "ringing",
      at: now,
    });
    await contacts.stamp(c.env.DB, owner.username, to, "last_called_at", now);
    return xml(c, dialOutTwiml(to, owner.connection.settings.from_number));
  })
  .post("/messages", async (c) => {
    const params = await form(c);
    const owner = await ownerOfNumber(c, params.To ?? "");
    if (!owner) {
      return c.text("not found", 404);
    }
    if (!(await signed(c, owner, params))) {
      return c.text("forbidden", 403);
    }
    const from = bareNumber(params.From ?? "");
    const contact = await contacts.byPhone(c.env.DB, owner.username, from);
    const now = Date.now();
    await messages.create(c.env.DB, {
      username: owner.username,
      contact_id: contact?.id ?? null,
      channel: (params.From ?? "").startsWith(WHATSAPP_PREFIX) ? "whatsapp" : "sms",
      direction: "in",
      phone: from,
      body: (params.Body ?? "").slice(0, 1600),
      sid: params.MessageSid ?? null,
      status: "received",
      at: now,
    });
    await contacts.stamp(c.env.DB, owner.username, from, "last_messaged_at", now);
    return xml(c, emptyTwiml());
  })
  .post("/status", async (c) => {
    const params = await form(c);
    const call = params.CallSid ? await calls.bySid(c.env.DB, params.CallSid) : null;
    const row = call ? await connections.get(c.env.DB, call.username, "twilio") : null;
    if (!call || !row) {
      return c.text("not found", 404);
    }
    const owner = { username: call.username, connection: await twilioFromRow(c, row) };
    if (!(await signed(c, owner, params))) {
      return c.text("forbidden", 403);
    }
    const status = (params.CallStatus ?? "").slice(0, 32);
    await calls.setStatus(c.env.DB, call.sid ?? "", status);
    const place = { env: c.env, origin: new URL(c.req.url).origin };
    if (status === "in-progress" && call.role === "host") {
      await hostAnswered(place, call);
    }
    if (status === "in-progress" && call.role === "guest") {
      await guestAnswered(place, call);
    }
    return c.body(null, 204);
  });

async function form(c: Context<AppEnv>): Promise<Params> {
  const params: Params = {};
  for (const [key, value] of await c.req.raw.formData()) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }
  return params;
}

async function ownerOfNumber(c: Context<AppEnv>, to: string): Promise<Owner | null> {
  const row = await connections.twilioByNumber(c.env.DB, bareNumber(to));
  return row ? { username: row.username, connection: await twilioFromRow(c, row) } : null;
}

const signed = (c: Context<AppEnv>, owner: Owner, params: Params) =>
  validSignature(owner.connection.client.secret.auth_token, c.req.url, params, c.req.header("x-twilio-signature"));

const xml = (c: Context<AppEnv>, body: string, status: 200 | 404 = 200) =>
  c.body(body, status, { "content-type": "text/xml; charset=utf-8" });
