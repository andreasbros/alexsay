import { canJoinCalls, openaiConnection, type TwilioConnection, twilioConnection } from "./connections";
import { type CallRow, calls, contacts, messages } from "./db";
import { logFor } from "./log";
import { contextInstructions, currentConversation, loadContext } from "./memory";
import { toWhatsapp } from "./phone";
import {
  addParticipant,
  CLIENT_IDENTITY,
  completeCall,
  createCall,
  getCall,
  redirectCall,
  sendMessage,
  type Webhooks,
} from "./providers/twilio";
import type { Recipient } from "./recipients";
import { announceTwiml, digitsTwiml } from "./twiml";
import type { Channel, Scope, ToolContext, VoiceClient } from "./types";

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
  /** Where the user takes the call: the page's own phone line, or their mobile when they asked for it. */
  host: VoiceClient;
}

/** A conference as it starts: only the host is ringing; guests and the assistant follow in stages. */
export interface Conference {
  conference: string;
  host: VoiceClient;
  /** Who will be dialled once the host is on the line. */
  pending: string[];
  /** True when the assistant will join once someone has answered. */
  assistant: boolean;
}

/** A guest to dial once the host answered, kept on the host leg until then. */
interface Guest {
  phone: string;
  contact_id: string | null;
  name: string | null;
  note: string | null;
}

interface HostBrief {
  task?: string;
  guests: Guest[];
  dialled?: boolean;
}

/** Where the app lives, for the URLs Twilio calls back; a tool context or a webhook request both know it. */
export interface Place extends Scope {
  origin: string;
}

export const statusCallbackUrl = (place: Place) => `${place.origin}/v1/twilio/status`;
export const conferenceStatusCallbackUrl = (place: Place) => `${place.origin}/v1/twilio/conference`;

/** The URLs a Twilio number is pointed at, derived from the request so local and live differ naturally. */
export function webhooks(origin: string): Webhooks {
  return {
    voiceUrl: `${origin}/v1/twilio/voice`,
    smsUrl: `${origin}/v1/twilio/messages`,
    statusCallback: `${origin}/v1/twilio/status`,
  };
}

type Ready = TwilioConnection & { from: string };

async function ready(scope: Scope, username: string): Promise<Ready> {
  const connection = await twilioConnection(scope, username);
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
 * A call for the user. With a message, the person is phoned and the message read out. Otherwise a
 * conference opens in stages: the user's side rings first (the Assistant page, or their mobile when
 * they asked for it); once they are on, the person is dialled and the assistant is dialled in over SIP
 * right behind them, so it hears the ringing, the greeting, a recording or a menu from the first second.
 */
export async function placeCall(
  c: ToolContext,
  username: string,
  recipient: Recipient,
  options: CallOptions,
): Promise<Placed | Conference> {
  const connection = await ready(c, username);
  if (options.message) {
    return announce(c, username, connection, recipient, options.message);
  }
  return openConference(c, username, connection, [recipient], options.host, options.task);
}

async function announce(
  c: Place,
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
  c: Scope,
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

/** A group call, opened the same staged way as a single call. */
export async function startConference(
  c: ToolContext,
  username: string,
  participants: Recipient[],
  host: VoiceClient,
): Promise<Conference> {
  const connection = await ready(c, username);
  return openConference(c, username, connection, participants, host);
}

async function openConference(
  c: Place,
  username: string,
  connection: Ready,
  recipients: Recipient[],
  host: VoiceClient,
  task?: string,
): Promise<Conference> {
  const conference = `ay-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const hostTo = host === "browser" ? `client:${CLIENT_IDENTITY}?conference=${conference}` : myNumber(connection);
  const brief: HostBrief = {
    task,
    guests: recipients.map((r) => ({
      phone: r.phone,
      contact_id: r.contact?.id ?? null,
      name: r.contact?.name ?? null,
      note: r.contact?.note || null,
    })),
  };
  const hostLeg = await addParticipant(connection.client, conference, {
    to: hostTo,
    from: connection.from,
    label: "host",
    host: true,
    statusCallback: statusCallbackUrl(c),
    conferenceStatusCallback: conferenceStatusCallbackUrl(c),
  });
  await calls.create(c.env.DB, {
    username,
    contact_id: null,
    direction: "out",
    kind: "conference",
    phone: host === "browser" ? "browser" : hostTo,
    conference,
    role: "host",
    brief: JSON.stringify(brief),
    sid: hostLeg.sid,
    status: hostLeg.status,
    at: Date.now(),
  });
  const openai = await openaiConnection(c, username);
  const pending = brief.guests.map((g) => g.name ?? g.phone);
  void logFor(
    c,
    username,
    "info",
    `call ${conference}: ringing the ${host === "browser" ? "app" : "mobile"} first; ` +
      `then ${pending.join(", ")}; assistant ${canJoinCalls(openai) ? "will join" : "not set up"}`,
  );
  return {
    conference,
    host,
    pending,
    assistant: canJoinCalls(openai),
  };
}

/**
 * The host picked up: dial everyone who was waiting for them, once, and seat the assistant straight
 * after, so it is on the line whatever answers: a person, a recorded service, a menu, voicemail.
 */
export async function hostAnswered(place: Place, hostLeg: CallRow): Promise<void> {
  const brief = parseBrief(hostLeg.brief);
  if (!hostLeg.conference || !brief || brief.dialled || brief.guests.length === 0) {
    return;
  }
  await calls.setBrief(place.env.DB, hostLeg.id, JSON.stringify({ ...brief, dialled: true }));
  void logFor(
    place,
    hostLeg.username,
    "info",
    `call ${hostLeg.conference}: host is on, dialling ${brief.guests.length}`,
  );
  const connection = await ready(place, hostLeg.username);
  for (const guest of brief.guests) {
    await dialGuest(place, hostLeg.username, connection, hostLeg.conference, guest);
  }
  await seatAssistant(place, hostLeg.username, hostLeg.conference, brief);
}

async function dialGuest(place: Place, username: string, connection: Ready, conference: string, guest: Guest) {
  const now = Date.now();
  const leg = await addParticipant(connection.client, conference, {
    to: guest.phone,
    from: connection.from,
    label: guest.name ?? guest.phone,
    host: false,
    statusCallback: statusCallbackUrl(place),
    conferenceStatusCallback: conferenceStatusCallbackUrl(place),
  });
  await calls.create(place.env.DB, {
    username,
    contact_id: guest.contact_id,
    direction: "out",
    kind: "conference",
    phone: guest.phone,
    conference,
    role: "guest",
    sid: leg.sid,
    status: leg.status,
    at: now,
  });
  await contacts.stamp(place.env.DB, username, guest.phone, "last_called_at", now);
  void logFor(place, username, "info", `call ${conference}: dialled ${guest.name ?? guest.phone} (${leg.status})`);
  return placed(leg, { phone: guest.phone, contact: null });
}

/** A guest picked up: noted for the log; the assistant is already on the line. */
export async function guestAnswered(place: Place, guestLeg: CallRow): Promise<void> {
  void logFor(place, guestLeg.username, "info", `call ${guestLeg.conference}: ${guestLeg.phone} answered`);
}

/** Dials the assistant's SIP leg into the conference; the unique seat means it happens once per call. */
async function seatAssistant(place: Place, username: string, conference: string, hostBrief: HostBrief): Promise<void> {
  const openai = await openaiConnection(place, username);
  if (!canJoinCalls(openai)) {
    return;
  }
  const seat = { id: crypto.randomUUID(), username, conference, at: Date.now() };
  if (!(await calls.claimAssistant(place.env.DB, seat))) {
    return;
  }
  const connection = await ready(place, username);
  const brief = await callBrief(place, username, hostBrief);
  const to = `sip:${openai.settings.project_id}@${OPENAI_SIP_HOST};transport=tls?${CONFERENCE_HEADER}=${conference}`;
  const leg = await addParticipant(connection.client, conference, {
    to,
    from: "alexsay",
    label: "assistant",
    host: false,
    statusCallback: statusCallbackUrl(place),
    conferenceStatusCallback: conferenceStatusCallbackUrl(place),
  });
  await calls.setBrief(place.env.DB, seat.id, brief);
  await calls.setLeg(place.env.DB, seat.id, leg.sid, leg.status);
  void logFor(place, username, "info", `call ${conference}: assistant dialled in over SIP`);
}

const parseBrief = (text: string | null): HostBrief | null => {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as HostBrief;
    return Array.isArray(parsed.guests) ? parsed : null;
  } catch {
    return null;
  }
};

/** What the assistant on the line is told: who is there, who answered, what to do, and what it remembers. */
async function callBrief(place: Scope, username: string, hostBrief: HostBrief | null): Promise<string> {
  const guests = hostBrief?.guests ?? [];
  const people = guests.map((g) => (g.name ? `${g.name} (${g.phone})` : g.phone)).join(", ") || "the person called";
  const notes = guests
    .filter((g) => g.note)
    .map((g) => `About ${g.name ?? g.phone}: ${g.note}`)
    .join("\n");
  const picked =
    "The other side is being dialled as you join: you may hear ringing first. Listen: what answers may be a " +
    "person, a recorded service, voicemail, or an automated menu or switchboard. For a menu, do not talk to it; " +
    "choose the option that fits with press_digits, one step at a time (for example 2 for billing), and tell " +
    `${username} briefly what you pressed. If no option fits, ask ${username}. For a recording or a service that ` +
    "only talks (a speaking clock, an announcement), say nothing and let it be heard. Hold music, a queue " +
    `message or a long recording: tell ${username} in one short line what is happening (for example "we are in ` +
    'a queue") and keep listening; mention it again only when it changes.';
  const conduct = hostBrief?.task
    ? `${username} asked you to handle this: ${hostBrief.task}. Once a person is on and has finished their ` +
      `greeting, introduce yourself as Alexsay calling on behalf of ${username} and get it done politely and ` +
      `concisely; hand over whenever ${username} speaks.`
    : `Do not introduce yourself and do not speak first to a person. Stay silent unless ${username} addresses you by ` +
      "name (Alexsay, Aleksey) or asks you to introduce yourself; then help briefly and go quiet again.";
  const aside =
    `${username} can also talk to you without your name when it is clearly for you and not for the other side: a ` +
    'question about the call ("did you hear that?", "what did they say?", "are we still in the queue?") gets a ' +
    `short answer. What ${username} says to the other side, you leave alone.`;
  const parts = [
    'Your name is Alexsay, pronounced "Aleksey". You have just joined a phone call that ' +
      `${username} placed from their speaker app. On the line: ${username}, and ${people}. ${picked} ${conduct} ` +
      `${aside} ` +
      `Keep every turn short. Never read out numbers, addresses or other personal details ${username} has not asked ` +
      "you to share.",
    `Tools: when ${username} asks you to hang up or end the call, say a brief goodbye to the other side and call ` +
      "end_call. When they ask to add someone, use find_contact if you need the number, then add_to_call, once per " +
      "person. The other tools (contacts, memory, lights, messages) work as usual. Speak only in the language the " +
      "people on the call use.",
    notes,
    await currentConversation(place.env.DB, username),
    contextInstructions(await loadContext(place.env.DB, username)),
  ];
  return parts.filter(Boolean).join("\n\n");
}

export interface LegProgress {
  who: string;
  role: string;
  status: string;
  seconds: number;
}

export interface CallProgress {
  in_call: boolean;
  conference?: string;
  legs?: LegProgress[];
}

/**
 * How the user's call is going, leg by leg, read live from Twilio (and stored), so the assistant on
 * the page can answer "has it connected?" with facts even when Twilio's callbacks never arrived.
 */
export async function callStatus(c: Scope, username: string): Promise<CallProgress> {
  const connection = await ready(c, username);
  const conference = await calls.openConference(c.env.DB, username, Date.now() - CONFERENCE_WINDOW_MS);
  if (!conference) {
    return { in_call: false };
  }
  const legs: LegProgress[] = [];
  for (const leg of await calls.legs(c.env.DB, conference)) {
    let state = { status: leg.status, seconds: 0 };
    if (leg.sid) {
      try {
        state = await getCall(connection.client, leg.sid);
      } catch {
        state = { status: leg.status, seconds: 0 };
      }
      if (state.status !== leg.status) {
        await calls.setStatus(c.env.DB, leg.sid, state.status);
      }
    }
    legs.push({ who: await legName(c, leg), role: leg.role, ...state });
  }
  return { in_call: legs.some((l) => !TERMINAL_STATUSES.has(l.status)), conference, legs };
}

const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

async function legName(c: Scope, leg: CallRow): Promise<string> {
  if (leg.role === "host") {
    return leg.phone === "browser" ? "the user, in the app" : "the user, on their mobile";
  }
  if (leg.role === "assistant") {
    return "you, the assistant";
  }
  const contact = await contacts.byPhone(c.env.DB, leg.username, leg.phone);
  return contact ? `${contact.name} (${leg.phone})` : leg.phone;
}

/** Brings one more person into the conference the user is in. */
export async function addToConference(c: ToolContext, username: string, recipient: Recipient): Promise<Placed> {
  const connection = await ready(c, username);
  const conference = await calls.openConference(c.env.DB, username, Date.now() - CONFERENCE_WINDOW_MS);
  if (!conference) {
    throw new TelephonyError("no_open_conference", "there is no call in progress; start one first");
  }
  const guest: Guest = {
    phone: recipient.phone,
    contact_id: recipient.contact?.id ?? null,
    name: recipient.contact?.name ?? null,
    note: recipient.contact?.note || null,
  };
  const result = await dialGuest(c, username, connection, conference, guest);
  return { ...result, contact: recipient.contact?.name ?? null };
}

/** Touch tones for the menu on the other side of the call: the live guest leg plays them and rejoins. */
export async function pressDigits(c: Scope, username: string, digits: string): Promise<{ digits: string }> {
  const connection = await ready(c, username);
  const conference = await calls.openConference(c.env.DB, username, Date.now() - CONFERENCE_WINDOW_MS);
  const guest = conference ? await calls.liveGuest(c.env.DB, conference) : null;
  if (!conference || !guest?.sid) {
    throw new TelephonyError("no_open_conference", "there is no call in progress to press digits on");
  }
  await redirectCall(connection.client, guest.sid, digitsTwiml(digits, conference));
  return { digits };
}

/** Hangs up the user's current call by ending the host leg, which takes the whole conference down. */
export async function endCall(c: Scope, username: string): Promise<{ conference: string }> {
  const connection = await ready(c, username);
  const conference = await calls.openConference(c.env.DB, username, Date.now() - CONFERENCE_WINDOW_MS);
  const host = conference ? await calls.hostLeg(c.env.DB, username, conference) : null;
  if (!conference || !host?.sid) {
    throw new TelephonyError("no_open_conference", "there is no call in progress");
  }
  await completeCall(connection.client, host.sid);
  await calls.endConference(c.env.DB, conference);
  void logFor(c, username, "info", `call ${conference}: hung up`);
  return { conference };
}

/** The assistant on the line has the whole registry except the one that ends the app's own session. */
export const notOnCalls = (name: string) => name === "end_conversation";
