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

/** A speaker dialled out through the SIP domain: place the real call with the user's Twilio number. */
export const dialOutTwiml = (to: string, callerId: string) => bridgeTwiml(to, callerId);

export const rejectTwiml = (reason: string) => response(`<Say ${SAY_VOICE}>${escapeXml(reason)}</Say><Hangup/>`);

export const emptyTwiml = () => response("");
