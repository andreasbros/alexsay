/** The call scripts Twilio runs for us; everything user-provided is escaped before it enters the XML. */

const SAY_VOICE = 'voice="Polly.Amy" language="en-GB"';
const RING_SECONDS = 25;

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
export const announceTwiml = (message: string) => {
  const say = `<Say ${SAY_VOICE}>${escapeXml(message)}</Say>`;
  return response(`${say}<Pause length="1"/>${say}`);
};

/**
 * Someone called the user's Twilio number: ring the app in the browser, every registered speaker
 * and the user's own phone at once; whoever answers first takes the call. Without any, say so and hang up.
 */
export function ringTwiml(sipUris: string[], mobile: string | null, client: string | null = null): string {
  const targets = [
    ...(client ? [`<Client>${escapeXml(client)}</Client>`] : []),
    ...sipUris.map((uri) => `<Sip>${escapeXml(uri)}</Sip>`),
    ...(mobile ? [`<Number>${escapeXml(mobile)}</Number>`] : []),
  ];
  if (targets.length === 0) {
    return response(
      `<Say ${SAY_VOICE}>Nothing is set up to take this call: no app open, no speaker and no other phone.</Say><Hangup/>`,
    );
  }
  return response(`<Dial timeout="${RING_SECONDS}">${targets.join("")}</Dial>`);
}

/**
 * The host leg of a call taken on a speaker: a call from the user's number to itself joins the
 * conference as host, and the inbound side of that call carries the conference to the speaker.
 */
export const conferenceHostTwiml = (conference: string, conferenceStatusCallback: string) =>
  response(
    `<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" ` +
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

export const rejectTwiml = (reason: string) => response(`<Say ${SAY_VOICE}>${escapeXml(reason)}</Say><Hangup/>`);

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
