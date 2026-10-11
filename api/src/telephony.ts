import type { Context } from "hono";
import { type TwilioConnection, twilioConnection } from "./connections";
import { calls, contacts, messages } from "./db";
import { toWhatsapp } from "./phone";
import { addParticipant, createCall, sendMessage } from "./providers/twilio";
import type { Recipient } from "./recipients";
import { announceTwiml, bridgeTwiml } from "./twiml";
import type { AppEnv, Channel } from "./types";

/** A precondition the user can fix in Connections, told apart from a Twilio failure. */
export class TelephonyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CONFERENCE_WINDOW_MS = 6 * 3_600_000;

export interface Placed {
  sid: string;
  status: string;
  phone: string;
  contact: string | null;
}

export const statusCallbackUrl = (c: Context<AppEnv>) => `${new URL(c.req.url).origin}/v1/twilio/status`;

async function ready(c: Context<AppEnv>, username: string): Promise<TwilioConnection & { from: string }> {
  const connection = await twilioConnection(c, username);
  if (!connection) {
    throw new TelephonyError("no_twilio_connection", "Twilio is not connected");
  }
  if (!connection.settings.from_number) {
    throw new TelephonyError("no_from_number", "no Twilio phone number is selected in Connections");
  }
  return { ...connection, from: connection.settings.from_number };
}

function myNumber(connection: TwilioConnection): string {
  if (!connection.settings.my_number) {
    throw new TelephonyError("no_my_number", "the user's own mobile number is not set in Connections");
  }
  return connection.settings.my_number;
}

/**
 * Rings the user's own phone and, once answered, connects the person asked for. With a message it
 * instead phones that person and reads the message out, so the user need not pick up at all.
 */
export async function placeCall(
  c: Context<AppEnv>,
  username: string,
  recipient: Recipient,
  message?: string,
): Promise<Placed> {
  const connection = await ready(c, username);
  const now = Date.now();
  const sent = message
    ? await createCall(connection.client, {
        to: recipient.phone,
        from: connection.from,
        twiml: announceTwiml(message),
        statusCallback: statusCallbackUrl(c),
      })
    : await createCall(connection.client, {
        to: myNumber(connection),
        from: connection.from,
        twiml: bridgeTwiml(recipient.phone, connection.from),
        statusCallback: statusCallbackUrl(c),
      });
  await calls.create(c.env.DB, {
    username,
    contact_id: recipient.contact?.id ?? null,
    direction: "out",
    kind: message ? "announcement" : "call",
    phone: recipient.phone,
    conference: null,
    sid: sent.sid,
    status: sent.status,
    at: now,
  });
  await contacts.stamp(c.env.DB, username, recipient.phone, "last_called_at", now);
  return { sid: sent.sid, status: sent.status, phone: recipient.phone, contact: recipient.contact?.name ?? null };
}

export async function sendText(
  c: Context<AppEnv>,
  username: string,
  recipient: Recipient,
  body: string,
  channel: Channel,
): Promise<Placed> {
  const connection = await ready(c, username);
  const whatsapp = channel === "whatsapp";
  if (whatsapp && !connection.settings.whatsapp_from) {
    throw new TelephonyError("no_whatsapp_sender", "no WhatsApp sender is set in Connections");
  }
  const sent = await sendMessage(connection.client, {
    to: whatsapp ? toWhatsapp(recipient.phone) : recipient.phone,
    from: whatsapp ? toWhatsapp(connection.settings.whatsapp_from) : connection.from,
    body,
  });
  const now = Date.now();
  await messages.create(c.env.DB, {
    username,
    contact_id: recipient.contact?.id ?? null,
    channel,
    direction: "out",
    phone: recipient.phone,
    body,
    sid: sent.sid,
    status: sent.status,
    at: now,
  });
  await contacts.stamp(c.env.DB, username, recipient.phone, "last_messaged_at", now);
  return { sid: sent.sid, status: sent.status, phone: recipient.phone, contact: recipient.contact?.name ?? null };
}

/** A new group call: the user's phone joins as host (ending it when they hang up), then everyone else. */
export async function startConference(
  c: Context<AppEnv>,
  username: string,
  participants: Recipient[],
): Promise<{ conference: string; joined: Placed[] }> {
  const connection = await ready(c, username);
  const host = myNumber(connection);
  const conference = `ay-${crypto.randomUUID().slice(0, 8)}`;
  const callback = statusCallbackUrl(c);
  const now = Date.now();
  const hostLeg = await addParticipant(connection.client, conference, {
    to: host,
    from: connection.from,
    label: "host",
    host: true,
    statusCallback: callback,
  });
  await calls.create(c.env.DB, {
    username,
    contact_id: null,
    direction: "out",
    kind: "conference",
    phone: host,
    conference,
    sid: hostLeg.sid,
    status: hostLeg.status,
    at: now,
  });
  const joined: Placed[] = [];
  for (const recipient of participants) {
    joined.push(await joinConference(c, username, connection, conference, recipient));
  }
  return { conference, joined };
}

/** Brings one more person into the conference the user is in. */
export async function addToConference(c: Context<AppEnv>, username: string, recipient: Recipient): Promise<Placed> {
  const connection = await ready(c, username);
  const conference = await calls.openConference(c.env.DB, username, Date.now() - CONFERENCE_WINDOW_MS);
  if (!conference) {
    throw new TelephonyError("no_open_conference", "there is no group call in progress; start one first");
  }
  return joinConference(c, username, connection, conference, recipient);
}

async function joinConference(
  c: Context<AppEnv>,
  username: string,
  connection: TwilioConnection & { from: string },
  conference: string,
  recipient: Recipient,
): Promise<Placed> {
  const now = Date.now();
  const leg = await addParticipant(connection.client, conference, {
    to: recipient.phone,
    from: connection.from,
    label: recipient.contact?.name ?? recipient.phone,
    host: false,
    statusCallback: statusCallbackUrl(c),
  });
  await calls.create(c.env.DB, {
    username,
    contact_id: recipient.contact?.id ?? null,
    direction: "out",
    kind: "conference",
    phone: recipient.phone,
    conference,
    sid: leg.sid,
    status: leg.status,
    at: now,
  });
  await contacts.stamp(c.env.DB, username, recipient.phone, "last_called_at", now);
  return { sid: leg.sid, status: leg.status, phone: recipient.phone, contact: recipient.contact?.name ?? null };
}
