/** The call scripts Twilio runs for us; everything user-provided is escaped before it enters the XML. */

/** A British male neural voice: natural, and ready on every Twilio account without setup. */
export const DEFAULT_VOICE = "Polly.Arthur-Neural";

/**
 * The attributes of a `<Say>`: the voice, and the language it speaks (Google voices carry their
 * locale in the name; the Polly voices offered are all British English).
 */
export function sayAttrs(voice: string = DEFAULT_VOICE): string {
  const locale = /^Google\.([a-z]{2}-[A-Z]{2})-/.exec(voice)?.[1] ?? "en-GB";
  return `voice="${escapeXml(voice)}" language="${locale}"`;
}

export const escapeXml = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch] ?? ch,
  );

const response = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** The user's phone rang and was answered: connect them to the person they asked for. */
export const bridgeTwiml = (to: string, callerId: string) =>
  response(`<Dial callerId="${escapeXml(callerId)}"><Number>${escapeXml(to)}</Number></Dial>`);

/** A call that only delivers a spoken message, read twice so a late pick-up still hears it. */
export const announceTwiml = (message: string, voice?: string) => {
  const say = `<Say ${sayAttrs(voice)}>${escapeXml(message)}</Say>`;
  return response(`${say}<Pause length="1"/>${say}`);
};

/**
 * Someone called the user's Twilio number: they hear the greeting (Twilio's own voice, so it plays
 * whatever the assistant is doing) and wait in a conference of their own with hold music until
 * whoever answers joins as host and starts it.
 */
export const incomingTwiml = (greeting: string, conference: string, conferenceStatusCallback: string, voice?: string) =>
  response(
    `<Say ${sayAttrs(voice)}>${escapeXml(greeting)}</Say>` +
      `<Dial><Conference beep="false" startConferenceOnEnter="false" endConferenceOnExit="false" ` +
      `statusCallback="${escapeXml(conferenceStatusCallback)}" statusCallbackEvent="start end join leave">` +
      `${escapeXml(conference)}</Conference></Dial>`,
  );

export const hangupTwiml = () => response("<Hangup/>");

/**
 * The host leg of a call taken on a speaker: a call from the user's number to itself joins the
 * conference as host, and the inbound side of that call carries the conference to the speaker.
 */
export const conferenceHostTwiml = (conference: string, conferenceStatusCallback: string) =>
  conferenceSeatTwiml(conference, conferenceStatusCallback, true);

/**
 * A self-call that sits in the conference: as host (starts it on entering, ends it on leaving) or as a
 * plain participant. The inbound side of the call streams the conference to whoever holds the seat.
 */
export const conferenceSeatTwiml = (conference: string, conferenceStatusCallback: string, host: boolean) =>
  response(
    `<Dial><Conference beep="false" startConferenceOnEnter="${host}" endConferenceOnExit="${host}" ` +
      `statusCallback="${escapeXml(conferenceStatusCallback)}" statusCallbackEvent="start end join leave">` +
      `${escapeXml(conference)}</Conference></Dial>`,
  );

/** The inbound side of that self-call: a two-way media stream to the speaker's line. */
export const streamTwiml = (url: string, conference: string, who: string) =>
  response(
    `<Connect><Stream url="${escapeXml(url)}">` +
      `<Parameter name="conference" value="${escapeXml(conference)}"/>` +
      `<Parameter name="who" value="${escapeXml(who)}"/>` +
      `</Stream></Connect>`,
  );

/** A speaker dialled out through the SIP domain: place the real call with the user's Twilio number. */
export const dialOutTwiml = (to: string, callerId: string) => bridgeTwiml(to, callerId);

export const rejectTwiml = (reason: string, voice?: string) =>
  response(`<Say ${sayAttrs(voice)}>${escapeXml(reason)}</Say><Hangup/>`);

export const emptyTwiml = () => response("");

/**
 * Sends touch tones to the far side of a guest leg (a menu: "press 2 for billing") and puts the leg
 * straight back into its conference. Twilio takes the leg out while this runs, so the return is explicit.
 */
export const digitsTwiml = (digits: string, conference: string) =>
  response(
    `<Play digits="ww${escapeXml(digits)}"/>` +
      `<Dial><Conference beep="false" startConferenceOnEnter="false" endConferenceOnExit="false">${escapeXml(conference)}</Conference></Dial>`,
  );
