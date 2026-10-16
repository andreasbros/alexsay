import { type TwilioConnection, twilioConnection } from "./connections";
import { type CallRow, calls, contacts, notifications } from "./db";
import { notifyHome } from "./device_channel";
import { type JobRow, schedule } from "./jobs";
import { logFor } from "./log";
import { addParticipant, CLIENT_IDENTITY, getCall, redirectCall } from "./providers/twilio";
import type { TwilioSettings } from "./schemas";
import {
  type CallerInfo,
  cancelOtherRinging,
  carriesAssistant,
  conferenceStatusCallbackUrl,
  type HostBrief,
  isLiveLeg,
  type Place,
  ready,
  ringSpeaker,
  seatAssistant,
  statusCallbackUrl,
  TelephonyError,
} from "./telephony";
import { hangupTwiml, incomingTwiml, rejectTwiml } from "./twiml";
import type { NotificationKind, Scope, ToolContext } from "./types";

/** How long the home has to pick up before the caller is told to try again later. */
export const RING_MS = 40_000;
export const UNANSWERED_JOB = "call.unanswered";

export type IncomingPolicy = TwilioSettings["incoming_calls"];

// Spelled as it sounds: Twilio's voices read "Alexsay" as "Alex say"
const DEFAULT_GREETING = "Hi, this is Aleksei, {name}'s assistant. Please stay on the line while I'm connecting you.";
const DEFAULT_UNANSWERED = "Sorry, nobody can take your call right now. Please try again later.";
const CONTACTS_ONLY = "Sorry, this number only takes calls from people it knows. Goodbye.";

/** Whether a policy lets this caller or sender through. */
export const allowed = (policy: IncomingPolicy, known: boolean): boolean =>
  policy === "everyone" || (policy === "contacts" && known);

/** The home's name as callers hear it: the setting, or the home's id with a capital. */
export function ownerName(settings: Pick<TwilioSettings, "owner_name">, home: string): string {
  const name = settings.owner_name.trim() || home;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const greetingFor = (settings: Pick<TwilioSettings, "greeting" | "owner_name">, home: string): string =>
  (settings.greeting.trim() || DEFAULT_GREETING).replaceAll("{name}", ownerName(settings, home));

export const unansweredFor = (settings: Pick<TwilioSettings, "unanswered">): string =>
  settings.unanswered.trim() || DEFAULT_UNANSWERED;

/** A number in groups, so speech reads "+44 7700 900 123" rather than one long figure. */
export function spokenNumber(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 7) {
    return phone;
  }
  const country = digits.slice(0, 2);
  const rest = digits.slice(2);
  const groups = rest.match(/.{1,4}(?=(.{3})*$)|.+/g) ?? [rest];
  return `+${country} ${groups.join(" ")}`;
}

/** Who is calling or writing, as the home hears it: the contact's name, or the number read out. */
export const callerLabel = (contact: { name: string } | null, phone: string): string =>
  contact ? contact.name : spokenNumber(phone);

/** Keeps a notification and reads it out on the speakers. */
export async function notify(
  scope: Scope,
  home: string,
  row: { kind: NotificationKind; contact_id: string | null; phone: string; title: string; body: string; ref?: string },
  say: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await notifications.create(scope.env.DB, { id, home_id: home, ...row, ref: row.ref ?? null, at: Date.now() });
  await notifyHome(scope, home, { type: "notify", id, kind: row.kind, say });
  return id;
}

interface Owner {
  home: string;
  connection: TwilioConnection;
}

/**
 * Someone called the number. Off: hung up on. Contacts only and unknown: told so. Otherwise the caller
 * hears the greeting and hold music in a conference of their own while every speaker rings (a push:
 * the speaker announces who it is and asks), the app rings and the mobile rings, as conference hosts;
 * whoever answers first starts the conference and the rest are cancelled. Nobody in 40 s: the
 * scheduler tells the caller to try later.
 */
export async function incomingCall(
  place: Place,
  owner: Owner,
  params: { from: string; callSid: string; callStatus: string },
): Promise<string> {
  const { home } = owner;
  const { settings } = owner.connection;
  const contact = await contacts.byPhone(place.env.DB, home, params.from);
  const now = Date.now();
  if (!allowed(settings.incoming_calls, contact !== null)) {
    await calls.create(place.env.DB, {
      home_id: home,
      contact_id: contact?.id ?? null,
      direction: "in",
      kind: "call",
      phone: params.from,
      conference: null,
      sid: params.callSid,
      status: "rejected",
      at: now,
    });
    const why = settings.incoming_calls === "off" ? "incoming calls are off" : "not a contact";
    await logFor(place, home, "info", `incoming call from ${params.from} refused: ${why}`);
    return settings.incoming_calls === "off" ? hangupTwiml() : rejectTwiml(CONTACTS_ONLY, settings.voice);
  }
  const conference = `in-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const caller: CallerInfo = { phone: params.from, name: contact?.name ?? null, contact_id: contact?.id ?? null };
  await calls.create(place.env.DB, {
    home_id: home,
    contact_id: caller.contact_id,
    direction: "in",
    kind: "conference",
    phone: params.from,
    conference,
    role: "guest",
    brief: JSON.stringify({ caller }),
    sid: params.callSid,
    status: params.callStatus || "ringing",
    at: now,
  });
  await contacts.stamp(place.env.DB, home, params.from, "last_called_at", now);
  const label = callerLabel(contact, params.from);
  const rang = await ringHome(place, owner, conference, caller, label);
  await schedule(place, {
    home,
    topic: UNANSWERED_JOB,
    payload: { conference, sid: params.callSid, home },
    rule: { kind: "at", at: now + RING_MS },
  });
  await logFor(place, home, "info", `incoming call from ${label} (${params.from}): ${conference}, ringing ${rang}`);
  return incomingTwiml(greetingFor(settings, home), conference, conferenceStatusCallbackUrl(place), settings.voice);
}

/** Rings the speakers (by push), the app and the mobile; what was reached, for the log. */
async function ringHome(place: Place, owner: Owner, conference: string, caller: CallerInfo, label: string) {
  const { home, connection } = owner;
  const rang: string[] = [];
  const speakers = await notifyHome(place, home, {
    type: "call.incoming",
    conference,
    from: caller.phone,
    name: caller.name,
    say: `Call from ${label}`,
  });
  if (speakers > 0) {
    rang.push(`${speakers} speaker${speakers === 1 ? "" : "s"}`);
  }
  const brief: HostBrief = { guests: [], incoming: caller };
  const targets: { to: string; phone: string; what: string }[] = [
    {
      to: `client:${CLIENT_IDENTITY}?incoming=${conference}&from=${encodeURIComponent(label)}`,
      phone: "browser",
      what: "app",
    },
  ];
  if (connection.settings.my_number && connection.settings.my_number !== caller.phone) {
    targets.push({ to: connection.settings.my_number, phone: connection.settings.my_number, what: "mobile" });
  }
  for (const target of targets) {
    try {
      // Starts the conference when answered; while only ringing (or failing, the app not open) it must not end it
      const leg = await addParticipant(connection.client, conference, {
        to: target.to,
        from: connection.settings.from_number,
        label: target.what,
        host: true,
        endOnExit: false,
        statusCallback: statusCallbackUrl(place),
        conferenceStatusCallback: conferenceStatusCallbackUrl(place),
      });
      await calls.create(place.env.DB, {
        home_id: home,
        contact_id: null,
        direction: "out",
        kind: "conference",
        phone: target.phone,
        conference,
        role: "host",
        brief: JSON.stringify(brief),
        sid: leg.sid,
        status: leg.status,
        at: Date.now(),
      });
      rang.push(target.what);
    } catch (err) {
      // The app is not open, or the mobile cannot be reached: the others still ring
      await logFor(place, home, "info", `call ${conference}: could not ring the ${target.what}: ${errorText(err)}`);
    }
  }
  return rang.join(", ") || "nothing";
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : "failed");

export type AnswerMode = "speaker" | "assistant";

/**
 * A speaker takes the call (its line streams the conference, the assistant joins quietly), or hands
 * it to the assistant alone with instructions ("say I'm unavailable and take a message"). The first
 * answer wins; a call already taken or gone says so.
 */
export async function answerIncoming(
  place: Place & { device?: string },
  home: string,
  conference: string,
  mode: AnswerMode,
  instruction?: string,
): Promise<{ conference: string; host: AnswerMode; caller: string }> {
  const legs = await calls.legs(place.env.DB, conference);
  const caller = legs.find((l) => l.direction === "in" && l.role === "guest");
  if (!caller || caller.home_id !== home || !isLiveLeg(caller, Date.now())) {
    throw new TelephonyError("no_such_call", "that call is over");
  }
  if (legs.some((l) => (l.role === "host" || l.role === "assistant") && l.status === "in-progress")) {
    throw new TelephonyError("taken", "the call was answered somewhere else");
  }
  const brief: HostBrief = {
    guests: [],
    incoming: parseCaller(caller),
    task: instruction?.trim() || undefined,
    ...(mode === "speaker" && (await carriesAssistant(place, place.device)) ? { assistant_on_speaker: true } : {}),
  };
  const connection = await ready(place, home);
  if (mode === "assistant") {
    await seatAssistant(place, home, conference, brief, true);
    await cancelOtherRinging(place, home, conference, null);
    await logFor(
      place,
      home,
      "info",
      `call ${conference}: the assistant takes it alone: ${brief.task ?? "no instruction"}`,
    );
  } else {
    const hostLeg = await ringSpeaker(place, home, connection, conference);
    await calls.create(place.env.DB, {
      home_id: home,
      contact_id: null,
      direction: "out",
      kind: "conference",
      phone: "speaker",
      conference,
      role: "host",
      brief: JSON.stringify(brief),
      sid: hostLeg.sid,
      status: hostLeg.status,
      at: Date.now(),
    });
    await logFor(place, home, "info", `call ${conference}: answered on the speaker`);
  }
  return {
    conference,
    host: mode,
    caller: callerLabel(brief.incoming?.name ? { name: brief.incoming.name } : null, caller.phone),
  };
}

/** The caller as the incoming leg's brief recorded them. */
export function parseCaller(leg: CallRow): CallerInfo {
  try {
    const parsed = JSON.parse(leg.brief ?? "") as { caller?: CallerInfo };
    if (parsed.caller?.phone) {
      return parsed.caller;
    }
  } catch {
    // An older row: the number alone
  }
  return { phone: leg.phone, name: null, contact_id: leg.contact_id };
}

/**
 * The scheduler's handler 40 s after a call came in: still nobody on it, the caller hears the
 * unanswered message and the home is told of the missed call.
 */
/**
 * Whether the home is still ringing for an incoming call: the caller has not left the greeting and
 * joined the conference, and nobody has answered. A conference instance ending in that state is a
 * ringing leg that failed at once (the app not open), not the end of the call: Twilio makes a new
 * instance under the same name when the caller joins, so the speakers must keep ringing.
 */
export function stillRinging(legs: CallRow[], now = Date.now()): boolean {
  const caller = legs.find((l) => l.direction === "in" && l.role === "guest");
  if (!caller || caller.status === "in-progress" || !isLiveLeg(caller, now)) {
    return false;
  }
  return !legs.some((l) => (l.role === "host" || l.role === "assistant") && l.status === "in-progress");
}

export async function unansweredCall(scope: Scope, job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload) as { conference?: string; sid?: string; home?: string };
  const { conference, sid } = payload;
  const home = payload.home ?? job.home_id;
  if (!conference || !sid) {
    return;
  }
  const legs = await calls.legs(scope.env.DB, conference);
  const caller = legs.find((l) => l.sid === sid);
  const answered = legs.some((l) => (l.role === "host" || l.role === "assistant") && l.status === "in-progress");
  if (!caller || answered) {
    return;
  }
  const connection = await twilioConnection(scope, home);
  // A conference instance can end and be recreated under the same name (a ringing leg failed before the
  // caller joined), which marked the caller's row completed: Twilio knows whether they are still waiting
  if (!isLiveLeg(caller, Date.now())) {
    const live = connection ? await getCall(connection.client, sid).catch(() => null) : null;
    if (live?.status !== "in-progress" && live?.status !== "ringing") {
      return;
    }
  }
  if (connection) {
    await redirectCall(
      connection.client,
      sid,
      rejectTwiml(unansweredFor(connection.settings), connection.settings.voice),
    ).catch(() => undefined);
  }
  await calls.setStatus(scope.env.DB, sid, "no-answer");
  await cancelOtherRinging(scope, home, conference, null);
  const who = parseCaller(caller);
  const label = callerLabel(who.name ? { name: who.name } : null, who.phone);
  await notify(
    scope,
    home,
    {
      kind: "call",
      contact_id: who.contact_id,
      phone: who.phone,
      title: `Missed call from ${label}`,
      body: "",
      ref: conference,
    },
    `Missed call from ${label}.`,
  );
  await logFor(scope, home, "info", `call ${conference}: nobody answered in ${RING_MS / 1000} s; the caller was told`);
}

/** The assistant, on a call it took for the user, writes down what the caller wanted to say. */
export async function takeMessage(c: ToolContext, text: string): Promise<{ ok: true; from: string }> {
  const home = c.user.home;
  const conference = await calls.openConference(c.env.DB, home, Date.now() - 6 * 3_600_000);
  const legs = conference ? await calls.legs(c.env.DB, conference) : [];
  const caller = legs.find((l) => l.direction === "in" && l.role === "guest");
  const who = caller ? parseCaller(caller) : null;
  const label = who ? callerLabel(who.name ? { name: who.name } : null, who.phone) : "the caller";
  await notify(
    c,
    home,
    {
      kind: "note",
      contact_id: who?.contact_id ?? null,
      phone: who?.phone ?? "",
      title: `Message from ${label}`,
      body: text,
      ref: conference ?? undefined,
    },
    `Message from ${label}: ${text}`,
  );
  return { ok: true, from: label };
}
