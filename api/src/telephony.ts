import type { Context } from "hono";
import { canJoinCalls, openaiConnection, type TwilioConnection, twilioConnection } from "./connections";
import { calls, contacts, messages } from "./db";
import { contextInstructions, loadContext } from "./memory";
import { toWhatsapp } from "./phone";
import {
  addParticipant,
  CLIENT_IDENTITY,
  completeCall,
  createCall,
  sendMessage,
  type Webhooks,
} from "./providers/twilio";
import type { Recipient } from "./recipients";
import { announceTwiml, bridgeTwiml } from "./twiml";
import type { AppEnv, Channel, VoiceClient } from "./types";

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
const OPENAI_SIP_HOST = "sip.api.openai.com";
/** The SIP header Twilio carries to OpenAI, so the webhook can find whose call this is. */
export const CONFERENCE_HEADER = "X-Alexsay-Conference";

export interface Placed {
  sid: string;
  status: string;
  phone: string;
  contact: string | null;
}

export interface CallOptions {
  /** Spoken to the person instead of connecting anyone. */
  message?: string;
  /** What the assistant should get done on the call. */
  task?: string;
  voice: VoiceClient;
}

export interface Conference {
  conference: string;
  joined: Placed[];
  /** True when the assistant was dialled in as well. */
  assistant: boolean;
  /** Where the user is on the call. */
  host: VoiceClient;
}

export const statusCallbackUrl = (c: Context<AppEnv>) => `${new URL(c.req.url).origin}/v1/twilio/status`;

/** The URLs a Twilio number is pointed at, derived from the request so local and live differ naturally. */
export function webhooks(c: Context<AppEnv>): Webhooks {
  const origin = new URL(c.req.url).origin;
  return {
    voiceUrl: `${origin}/v1/twilio/voice`,
    smsUrl: `${origin}/v1/twilio/messages`,
    statusCallback: `${origin}/v1/twilio/status`,
  };
}

type Ready = TwilioConnection & { from: string };

async function ready(c: Context<AppEnv>, username: string): Promise<Ready> {
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
 * A call for the user. From the browser it is a conference the Assistant page joins at once, with
 * the person asked for and, when OpenAI's SIP endpoint is set up, the assistant on the line too.
 * From elsewhere the user's own phone rings first and is then bridged. With a message, the person
 * is phoned and the message read out instead.
 */
export async function placeCall(
  c: Context<AppEnv>,
  username: string,
  recipient: Recipient,
  options: CallOptions,
): Promise<Placed | Conference> {
  const connection = await ready(c, username);
  if (options.message) {
    return announce(c, username, connection, recipient, options.message);
  }
  if (options.voice === "browser") {
    return openConference(c, username, connection, [recipient], "browser", options.task);
  }
  const now = Date.now();
  const sent = await createCall(connection.client, {
    to: myNumber(connection),
    from: connection.from,
    twiml: bridgeTwiml(recipient.phone, connection.from),
    statusCallback: statusCallbackUrl(c),
  });
  await calls.create(c.env.DB, {
    username,
    contact_id: recipient.contact?.id ?? null,
    direction: "out",
    kind: "call",
    phone: recipient.phone,
    conference: null,
    sid: sent.sid,
    status: sent.status,
    at: now,
  });
  await contacts.stamp(c.env.DB, username, recipient.phone, "last_called_at", now);
  return placed(sent, recipient);
}

async function announce(
  c: Context<AppEnv>,
  username: string,
  connection: Ready,
  recipient: Recipient,
  message: string,
): Promise<Placed> {
  const now = Date.now();
  const sent = await createCall(connection.client, {
    to: recipient.phone,
    from: connection.from,
    twiml: announceTwiml(message),
    statusCallback: statusCallbackUrl(c),
  });
  await calls.create(c.env.DB, {
    username,
    contact_id: recipient.contact?.id ?? null,
    direction: "out",
    kind: "announcement",
    phone: recipient.phone,
    conference: null,
    sid: sent.sid,
    status: sent.status,
    at: now,
  });
  await contacts.stamp(c.env.DB, username, recipient.phone, "last_called_at", now);
  return placed(sent, recipient);
}

const placed = (sent: { sid: string; status: string }, recipient: Recipient): Placed => ({
  sid: sent.sid,
  status: sent.status,
  phone: recipient.phone,
  contact: recipient.contact?.name ?? null,
});

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
  return placed(sent, recipient);
}

/** A group call: the user joins as host (hanging up ends it), then everyone else, then the assistant. */
export async function startConference(
  c: Context<AppEnv>,
  username: string,
  participants: Recipient[],
  voice: VoiceClient,
): Promise<Conference> {
  const connection = await ready(c, username);
  return openConference(c, username, connection, participants, voice);
}

async function openConference(
  c: Context<AppEnv>,
  username: string,
  connection: Ready,
  recipients: Recipient[],
  voice: VoiceClient,
  task?: string,
): Promise<Conference> {
  const conference = `ay-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const callback = statusCallbackUrl(c);
  const now = Date.now();
  const hostTo = voice === "browser" ? `client:${CLIENT_IDENTITY}?conference=${conference}` : myNumber(connection);
  const hostLeg = await addParticipant(connection.client, conference, {
    to: hostTo,
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
    phone: voice === "browser" ? "browser" : hostTo,
    conference,
    role: "host",
    sid: hostLeg.sid,
    status: hostLeg.status,
    at: now,
  });
  const joined: Placed[] = [];
  for (const recipient of recipients) {
    joined.push(await joinConference(c, username, connection, conference, recipient));
  }
  const openai = await openaiConnection(c, username);
  let assistant = false;
  if (canJoinCalls(openai)) {
    const brief = await callBrief(c, username, recipients, task);
    const to = `sip:${openai.settings.project_id}@${OPENAI_SIP_HOST};transport=tls?${CONFERENCE_HEADER}=${conference}`;
    const leg = await addParticipant(connection.client, conference, {
      to,
      from: "alexsay",
      label: "assistant",
      host: false,
      statusCallback: callback,
    });
    await calls.create(c.env.DB, {
      username,
      contact_id: null,
      direction: "out",
      kind: "conference",
      phone: "assistant",
      conference,
      role: "assistant",
      brief,
      sid: leg.sid,
      status: leg.status,
      at: now,
    });
    assistant = true;
  }
  return { conference, joined, assistant, host: voice };
}

/** What the assistant on the line is told: who is on the call, what to do, and what it remembers. */
async function callBrief(
  c: Context<AppEnv>,
  username: string,
  recipients: Recipient[],
  task: string | undefined,
): Promise<string> {
  const people = recipients.map((r) => (r.contact ? `${r.contact.name} (${r.phone})` : r.phone)).join(", ");
  const notes = recipients
    .filter((r) => r.contact?.note)
    .map((r) => `About ${r.contact?.name}: ${r.contact?.note}`)
    .join("\n");
  const conduct = task
    ? `${username} asked you to handle this: ${task}. Introduce yourself briefly as Alexsay calling on behalf of ` +
      `${username}, get it done politely and concisely, and hand over whenever ${username} speaks.`
    : `Stay silent unless ${username} addresses you by name (Alexsay, Aleksey); then help briefly and go quiet again.`;
  const parts = [
    'Your name is Alexsay, pronounced "Aleksey". You are on a phone call together with ' +
      `${username}, who placed it from their speaker app, and ${people}. ${conduct} Keep every turn short. ` +
      `Never read out numbers, addresses or other personal details that ${username} has not asked you to share.`,
    notes,
    contextInstructions(await loadContext(c.env.DB, username)),
  ];
  return parts.filter(Boolean).join("\n\n");
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

/** Hangs up the user's current call by ending the host leg, which takes the whole conference down. */
export async function endCall(c: Context<AppEnv>, username: string): Promise<{ conference: string }> {
  const connection = await ready(c, username);
  const conference = await calls.openConference(c.env.DB, username, Date.now() - CONFERENCE_WINDOW_MS);
  const host = conference ? await calls.hostLeg(c.env.DB, username, conference) : null;
  if (!conference || !host?.sid) {
    throw new TelephonyError("no_open_conference", "there is no call in progress");
  }
  await completeCall(connection.client, host.sid);
  await calls.endConference(c.env.DB, conference);
  return { conference };
}

async function joinConference(
  c: Context<AppEnv>,
  username: string,
  connection: Ready,
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
    role: "guest",
    sid: leg.sid,
    status: leg.status,
    at: now,
  });
  await contacts.stamp(c.env.DB, username, recipient.phone, "last_called_at", now);
  return placed(leg, recipient);
}
