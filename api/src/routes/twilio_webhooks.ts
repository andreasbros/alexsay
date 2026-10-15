import type { Context } from "hono";
import { Hono } from "hono";
import { type TwilioConnection, twilioFromRow } from "../connections";
import { bridges, calls, connections, contacts, devices, messages } from "../db";
import { allowed, callerLabel, incomingCall, notify } from "../incoming";
import { logFor } from "../log";
import { serverOrigin } from "../origin";
import { bareNumber, normalisePhone, WHATSAPP_PREFIX } from "../phone";
import { validSignature } from "../providers/twilio";
import {
  BRIDGE_WINDOW_MS,
  callEnded,
  endedByFromLegs,
  guestAnswered,
  guestUnanswered,
  hostAnswered,
  streamUrl,
} from "../telephony";
import { dialOutTwiml, emptyTwiml, rejectTwiml, streamTwiml } from "../twiml";
import type { AppEnv } from "../types";

const SIP_USER = /^sip:([^@;]+)@/;

type Params = Record<string, string>;

interface Owner {
  home: string;
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
    const owner = await signedOwnerOfNumber(c, params);
    if (!owner) {
      return c.text("forbidden", 403);
    }
    const from = params.From ?? "";
    const place = { env: c.env, origin: serverOrigin(c) };
    // The number calling itself is a speaker's host leg: answer with the stream to that speaker
    if (bareNumber(from) === bareNumber(params.To ?? "")) {
      const bridge = await bridges.pending(c.env.DB, owner.home, Date.now() - BRIDGE_WINDOW_MS);
      if (!bridge) {
        return xml(c, rejectTwiml("No speaker is waiting for this call."));
      }
      await bridges.use(c.env.DB, bridge.token, Date.now());
      const host = await calls.hostLeg(c.env.DB, owner.home, bridge.conference);
      if (host) {
        await calls.setStatus(c.env.DB, host.sid ?? "", "in-progress");
        // The speaker is answered first: dialling everyone before the reply kept the host out of the
        // conference meanwhile (and risks Twilio's webhook timeout); the host's join retries it anyway
        c.executionCtx.waitUntil(hostAnswered(place, host));
      }
      await logFor(place, owner.home, "info", `call ${bridge.conference}: streaming to the speaker`);
      return xml(c, streamTwiml(streamUrl(place, bridge.token), bridge.conference, "speaker"));
    }
    return xml(
      c,
      await incomingCall(place, owner, {
        from,
        callSid: params.CallSid ?? "",
        callStatus: params.CallStatus ?? "ringing",
      }),
    );
  })
  .post("/voice/outbound", async (c) => {
    const params = await form(c);
    const deviceId = SIP_USER.exec(params.From ?? "")?.[1] ?? "";
    const device = await devices.get(c.env.DB, deviceId);
    const row = device?.home_id ? await connections.get(c.env.DB, device.home_id, "twilio") : null;
    if (!device?.home_id || !row) {
      return xml(c, rejectTwiml("This speaker is not set up for calls."), 404);
    }
    const owner = { home: device.home_id, connection: await twilioFromRow(c, row) };
    if (!(await signed(c, owner, params))) {
      return c.text("forbidden", 403);
    }
    const dialled = SIP_USER.exec(params.To ?? "")?.[1] ?? "";
    const to = normalisePhone(decodeSafe(dialled), owner.connection.settings.country_code);
    if (!to || !owner.connection.settings.from_number) {
      return xml(c, rejectTwiml("That number cannot be dialled."));
    }
    const contact = await contacts.byPhone(c.env.DB, owner.home, to);
    const now = Date.now();
    await calls.create(c.env.DB, {
      home_id: owner.home,
      contact_id: contact?.id ?? null,
      direction: "out",
      kind: "call",
      phone: to,
      conference: null,
      sid: params.CallSid ?? null,
      status: params.CallStatus ?? "ringing",
      at: now,
    });
    await contacts.stamp(c.env.DB, owner.home, to, "last_called_at", now);
    return xml(c, dialOutTwiml(to, owner.connection.settings.from_number));
  })
  .post("/messages", async (c) => {
    const params = await form(c);
    const owner = await signedOwnerOfNumber(c, params);
    if (!owner) {
      return c.text("forbidden", 403);
    }
    const from = bareNumber(params.From ?? "");
    const contact = await contacts.byPhone(c.env.DB, owner.home, from);
    if (!allowed(owner.connection.settings.incoming_messages, contact !== null)) {
      await logFor(
        c,
        owner.home,
        "info",
        `incoming message from ${from} dropped: ${contact ? "messages off" : "not a contact"}`,
      );
      return xml(c, emptyTwiml());
    }
    const now = Date.now();
    const body = (params.Body ?? "").slice(0, 1600);
    const channel = (params.From ?? "").startsWith(WHATSAPP_PREFIX) ? "whatsapp" : "sms";
    await messages.create(c.env.DB, {
      home_id: owner.home,
      contact_id: contact?.id ?? null,
      channel,
      direction: "in",
      phone: from,
      body,
      sid: params.MessageSid ?? null,
      status: "received",
      at: now,
    });
    await contacts.stamp(c.env.DB, owner.home, from, "last_messaged_at", now);
    const label = callerLabel(contact, from);
    await notify(
      c,
      owner.home,
      {
        kind: "message",
        contact_id: contact?.id ?? null,
        phone: from,
        title: `${channel === "whatsapp" ? "WhatsApp" : "Text"} from ${label}`,
        body,
        ref: params.MessageSid,
      },
      `${channel === "whatsapp" ? "WhatsApp" : "Text"} message from ${label}: ${body}`,
    );
    await logFor(c, owner.home, "info", `incoming ${channel} from ${label} (${from})`);
    return xml(c, emptyTwiml());
  })
  .post("/status", async (c) => {
    const params = await form(c);
    const call = params.CallSid ? await calls.bySid(c.env.DB, params.CallSid) : null;
    const row = call ? await connections.get(c.env.DB, call.home_id, "twilio") : null;
    if (!call || !row) {
      return c.text("not found", 404);
    }
    const owner = { home: call.home_id, connection: await twilioFromRow(c, row) };
    if (!(await signed(c, owner, params))) {
      return c.text("forbidden", 403);
    }
    const status = (params.CallStatus ?? "").slice(0, 32);
    const changed = await calls.setStatus(c.env.DB, call.sid ?? "", status);
    const place = { env: c.env, origin: serverOrigin(c) };
    await logFor(place, call.home_id, "info", `twilio: ${call.role || call.kind} leg ${call.phone} is ${status}`);
    if (status === "in-progress" && call.role === "host") {
      await hostAnswered(place, call);
    }
    if (changed && status === "in-progress" && call.role === "guest") {
      await guestAnswered(place, call);
    }
    if (changed && UNANSWERED.has(status) && call.role === "guest") {
      await guestUnanswered(place, call, status);
    }
    return c.body(null, 204);
  });

const UNANSWERED = new Set(["busy", "no-answer", "failed", "canceled"]);

/**
 * Twilio opens the media stream for a speaker's call here, naming the pending bridge by its token;
 * the socket is handed to that speaker's line, which carries the audio both ways.
 */
export const twilioStreamRoute = new Hono<AppEnv>().get("/stream/:token", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected a websocket" }, 426);
  }
  const bridge = await bridges.get(c.env.DB, c.req.param("token"));
  if (!bridge || bridge.created_at < Date.now() - BRIDGE_WINDOW_MS * 4) {
    return c.text("forbidden", 403);
  }
  const line = c.env.LINE_BRIDGE.get(c.env.LINE_BRIDGE.idFromName(bridge.device_id));
  const url = new URL("https://line/twilio");
  url.searchParams.set("conference", bridge.conference);
  url.searchParams.set("who", "speaker");
  url.searchParams.set("home", bridge.home_id);
  return line.fetch(url.toString(), { headers: { upgrade: "websocket" } });
});

/**
 * Conference events are the stages' second trigger: when a leg's own callbacks go missing (they did
 * on 11 Oct 2026), the host's join still dials the guests, a guest's join is still logged, and the
 * end of the conference marks every leg completed whoever hung up.
 */
export const twilioConferenceRoute = new Hono<AppEnv>().post("/conference", async (c) => {
  const params = await form(c);
  const conference = (params.FriendlyName ?? "").slice(0, 64);
  const legs = conference ? await calls.legs(c.env.DB, conference) : [];
  const first = legs[0];
  const row = first ? await connections.get(c.env.DB, first.home_id, "twilio") : null;
  if (!first || !row) {
    return c.text("not found", 404);
  }
  const owner = { home: first.home_id, connection: await twilioFromRow(c, row) };
  if (!(await signed(c, owner, params))) {
    return c.text("forbidden", 403);
  }
  const event = (params.StatusCallbackEvent ?? "").slice(0, 32);
  const leg = params.CallSid ? (legs.find((l) => l.sid === params.CallSid) ?? null) : null;
  const place = { env: c.env, origin: serverOrigin(c) };
  await logFor(
    place,
    first.home_id,
    "info",
    `twilio: conference ${conference} ${event}${leg ? ` (${leg.role} ${leg.phone})` : ""}`,
  );
  if (event === "participant-join" && leg?.sid) {
    const changed = await calls.setStatus(c.env.DB, leg.sid, "in-progress");
    if (leg.role === "host") {
      await hostAnswered(place, leg);
    }
    if (changed && leg.role === "guest") {
      await guestAnswered(place, leg);
    }
  }
  if (event === "participant-leave" && leg?.sid) {
    await calls.setLeft(c.env.DB, leg.sid, Date.now());
  }
  if (event === "conference-end") {
    await calls.endConference(c.env.DB, conference);
    await callEnded(place, first.home_id, conference, endedByFromLegs(await calls.legs(c.env.DB, conference)));
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

/**
 * The user this webhook is for: of everyone who claims the number (the WhatsApp sandbox sender is
 * shared), the one whose auth token signed the request. Unknown and unsigned look the same (403).
 */
async function signedOwnerOfNumber(c: Context<AppEnv>, params: Params): Promise<Owner | null> {
  for (const row of await connections.twilioByNumber(c.env.DB, bareNumber(params.To ?? ""))) {
    const owner = { home: row.home_id, connection: await twilioFromRow(c, row) };
    if (await signed(c, owner, params)) {
      return owner;
    }
  }
  return null;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
}

const signed = (c: Context<AppEnv>, owner: Owner, params: Params) =>
  validSignature(owner.connection.client.secret.auth_token, c.req.url, params, c.req.header("x-twilio-signature"));

const xml = (c: Context<AppEnv>, body: string, status: 200 | 404 = 200) =>
  c.body(body, status, { "content-type": "text/xml; charset=utf-8" });
