import { ProviderError } from "./openai";

/**
 * What sits sealed in D1 for Twilio: the account and its auth token from the console, plus an API
 * key this app creates on first use to sign the browser's voice tokens.
 */
export interface TwilioSecret {
  account_sid: string;
  auth_token: string;
  api_key_sid?: string;
  api_key_secret?: string;
}

/** The Twilio Client identity every browser of a user registers as; one per user's Twilio account. */
export const CLIENT_IDENTITY = "alexsay-app";

export interface TwilioClient {
  baseUrl: string;
  secret: TwilioSecret;
}

export interface PhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  voice: boolean;
  sms: boolean;
}

interface NumberRow {
  sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities?: { voice?: boolean; sms?: boolean };
}

const API_VERSION = "2010-04-01";

async function request<T>(client: TwilioClient, path: string, form?: Record<string, string>): Promise<T> {
  const { account_sid, auth_token } = client.secret;
  const res = await fetch(`${client.baseUrl}/${API_VERSION}/Accounts/${account_sid}${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      authorization: `Basic ${btoa(`${account_sid}:${auth_token}`)}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await describe(res));
  }
  return (await res.json()) as T;
}

/** Twilio errors are JSON with a message and a code; keep the message, drop the account id if any. */
async function describe(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 400);
  try {
    const parsed = JSON.parse(text) as { message?: string; code?: number };
    return parsed.message ? `${parsed.message}${parsed.code ? ` (${parsed.code})` : ""}` : text;
  } catch {
    return text || res.statusText;
  }
}

/** Proves the SID and token pair works; Twilio answers with the account itself. */
export async function verifyAccount(client: TwilioClient): Promise<{ friendly_name: string; status: string }> {
  return request(client, ".json");
}

/** The numbers bought or ported into the account, with what each can do. */
export async function listNumbers(client: TwilioClient): Promise<PhoneNumber[]> {
  const body = await request<{ incoming_phone_numbers: NumberRow[] }>(
    client,
    "/IncomingPhoneNumbers.json?PageSize=100",
  );
  return body.incoming_phone_numbers.map((n) => ({
    sid: n.sid,
    phone_number: n.phone_number,
    friendly_name: n.friendly_name,
    voice: n.capabilities?.voice ?? false,
    sms: n.capabilities?.sms ?? false,
  }));
}

export interface Webhooks {
  voiceUrl: string;
  smsUrl: string;
  statusCallback: string;
}

/** Points a number's incoming call and message webhooks at this app, so the user never edits the console. */
export async function configureNumber(client: TwilioClient, numberSid: string, hooks: Webhooks): Promise<void> {
  await request(client, `/IncomingPhoneNumbers/${numberSid}.json`, {
    VoiceUrl: hooks.voiceUrl,
    VoiceMethod: "POST",
    SmsUrl: hooks.smsUrl,
    SmsMethod: "POST",
    StatusCallback: hooks.statusCallback,
    StatusCallbackMethod: "POST",
  });
}

export interface Sent {
  sid: string;
  status: string;
}

/** SMS or WhatsApp, decided by the whatsapp: prefix on both addresses. */
export async function sendMessage(
  client: TwilioClient,
  message: { to: string; from: string; body: string; statusCallback?: string },
): Promise<Sent> {
  return request(client, "/Messages.json", {
    To: message.to,
    From: message.from,
    Body: message.body,
    ...(message.statusCallback ? { StatusCallback: message.statusCallback } : {}),
  });
}

/** An outbound call that runs the given TwiML once answered. */
export async function createCall(
  client: TwilioClient,
  call: { to: string; from: string; twiml: string; statusCallback: string },
): Promise<Sent> {
  return request(client, "/Calls.json", {
    To: call.to,
    From: call.from,
    Twiml: call.twiml,
    StatusCallback: call.statusCallback,
    StatusCallbackEvent: "completed",
    StatusCallbackMethod: "POST",
  });
}

/**
 * Dials someone into a named conference, creating it on the first participant. Twilio accepts the
 * friendly name in place of the conference SID.
 */
export async function addParticipant(
  client: TwilioClient,
  conference: string,
  participant: { to: string; from: string; label: string; host: boolean; statusCallback: string },
): Promise<Sent> {
  const body = await request<{ call_sid: string; status: string }>(
    client,
    `/Conferences/${encodeURIComponent(conference)}/Participants.json`,
    {
      To: participant.to,
      From: participant.from,
      Label: participant.label,
      EndConferenceOnExit: participant.host ? "true" : "false",
      StartConferenceOnEnter: participant.host ? "true" : "false",
      Beep: "onEnter",
      StatusCallback: participant.statusCallback,
      StatusCallbackEvent: "completed",
      StatusCallbackMethod: "POST",
    },
  );
  return { sid: body.call_sid, status: body.status };
}

/**
 * Twilio signs every webhook: base64(HMAC-SHA1(auth token, url + sorted "keyvalue" pairs)).
 * See twilio.com/docs/usage/webhooks/webhooks-security.
 */
export async function validSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) {
    return false;
  }
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** An API key for signing access tokens; the secret is only ever returned on creation. */
export async function createApiKey(client: TwilioClient): Promise<{ sid: string; secret: string }> {
  return request(client, "/Keys.json", { FriendlyName: "alexsay app" });
}

/** Hangs up one leg; for a conference host that ends the whole call. */
export async function completeCall(client: TwilioClient, callSid: string): Promise<void> {
  await request(client, `/Calls/${encodeURIComponent(callSid)}.json`, { Status: "completed" });
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encodeSegment = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * A Twilio Access Token with a Voice grant: lets the browser register as CLIENT_IDENTITY and take
 * incoming calls. Signed HS256 with the API key, as twilio.com/docs/iam/access-tokens specifies.
 */
export async function voiceToken(
  secret: Required<Pick<TwilioSecret, "account_sid" | "api_key_sid" | "api_key_secret">>,
  identity: string,
  ttlSeconds: number,
  now = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${secret.api_key_sid}-${issuedAt}`,
    iss: secret.api_key_sid,
    sub: secret.account_sid,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    grants: { identity, voice: { incoming: { allow: true } } },
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.api_key_secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(mac))}`;
}
