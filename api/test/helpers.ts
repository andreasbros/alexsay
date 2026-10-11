import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { hashPassword } from "../src/crypto";

export const APP = "https://app.alexsay.com";
export const DEVICE_ID = "7d1d6e2e-7c7b-4f6a-9d0a-1d2e3f4a5b6c";

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    [
      "messages",
      "calls",
      "contacts",
      "conversation_turns",
      "conversations",
      "memories",
      "connections",
      "devices",
      "sessions",
      "login_failures",
      "users",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

export async function addUser(username: string, password: string, role: "admin" | "user"): Promise<void> {
  await env.DB.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, 0)")
    .bind(username, await hashPassword(password), role)
    .run();
}

export function call(url: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return exports.default.fetch(new Request(url, { ...init, headers }));
}

export const json = (url: string, method: string, body: unknown, cookie?: string) =>
  call(url, { method, body: JSON.stringify(body) }, cookie);

export async function signIn(username: string, password: string): Promise<string> {
  const res = await json(`${APP}/api/session/login`, "POST", { username, password });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (res.status !== 200 || !cookie) {
    throw new Error(`login failed: ${res.status}`);
  }
  return cookie;
}

export function heartbeat(deviceId: string | null, body: unknown = {}): Promise<Response> {
  const headers: Record<string, string> = deviceId ? { "x-device-id": deviceId } : {};
  return call(`${APP}/v1/device/heartbeat`, { method: "POST", headers, body: JSON.stringify(body) });
}

export const OPENAI_KEY = "sk-test-0123456789abcdefghijklmnop";
export const connectOpenai = (cookie: string, settings: Record<string, unknown> = {}) =>
  json(`${APP}/api/connections/openai`, "PUT", { api_key: OPENAI_KEY, settings }, cookie);

/** Saving Lightwave tokens exchanges them at once, so the save itself needs the auth server mocked. */
export async function connectLightwave(cookie: string): Promise<Response> {
  const upstream = mockUpstream({
    "POST https://auth.lightwaverf.com/token": () =>
      reply(200, { access_token: "access-0", refresh_token: "refresh-1", expires_in: 3600 }),
  });
  const res = await json(
    `${APP}/api/connections/lightwave`,
    "PUT",
    { basic_token: "basic-token-0123456789", refresh_token: "refresh-token-0123456789" },
    cookie,
  );
  upstream.done();
  return res;
}

export type UpstreamHandler = (req: Request, body: string) => Response | Promise<Response>;

/**
 * Replaces global fetch for calls that leave the Worker (OpenAI, Lightwave). Keys are
 * `METHOD url`; every handler must be hit once, and anything unexpected throws.
 */
export function mockUpstream(routes: Record<string, UpstreamHandler>): { calls: Request[]; done: () => void } {
  const pending = new Set(Object.keys(routes));
  const calls: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${req.url}`;
    // A trailing * matches any suffix, for URLs that carry a generated id such as a conference name
    const matched =
      key in routes ? key : Object.keys(routes).find((k) => k.endsWith("*") && key.startsWith(k.slice(0, -1)));
    const handler = matched ? routes[matched] : undefined;
    if (!handler || !matched) {
      throw new Error(`unexpected upstream call ${key}`);
    }
    pending.delete(matched);
    calls.push(req.clone());
    return handler(req, new TextDecoder().decode(await req.arrayBuffer()));
  }) as typeof fetch;
  return {
    calls,
    done: () => {
      globalThis.fetch = original;
      if (pending.size > 0) {
        throw new Error(`upstream never called: ${[...pending].join(", ")}`);
      }
    },
  };
}

export const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const TWILIO_SID = "AC0123456789abcdef0123456789abcdef";
export const TWILIO_TOKEN = "fedcba9876543210fedcba9876543210";
export const TWILIO = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}`;
export const TWILIO_NUMBER = "+447700900000";
export const MY_NUMBER = "+447700900999";

/** Saving Twilio verifies the account and points the chosen number's webhooks here, so both are mocked. */
export async function connectTwilio(cookie: string, settings: Record<string, unknown> = {}): Promise<Response> {
  const upstream = mockUpstream({
    [`GET ${TWILIO}.json`]: () => reply(200, { friendly_name: "Alexsay", status: "active" }),
    [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () =>
      reply(200, {
        incoming_phone_numbers: [
          { sid: "PN1", phone_number: TWILIO_NUMBER, friendly_name: "Home", capabilities: { voice: true, sms: true } },
        ],
      }),
    [`POST ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () => reply(200, { sid: "PN1" }),
    [`GET ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () =>
      reply(200, { sid: "PN1", phone_number: TWILIO_NUMBER, voice_url: `${APP}/v1/twilio/voice` }),
  });
  const res = await json(
    `${APP}/api/connections/twilio`,
    "PUT",
    {
      account_sid: TWILIO_SID,
      auth_token: TWILIO_TOKEN,
      settings: { from_number: TWILIO_NUMBER, my_number: MY_NUMBER, ...settings },
    },
    cookie,
  );
  upstream.done();
  return res;
}

/** A Twilio webhook as Twilio sends it: form encoded and signed with the account's auth token. */
export async function twilioWebhook(path: string, params: Record<string, string>, token = TWILIO_TOKEN) {
  const url = `${APP}${path}`;
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return call(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": btoa(String.fromCharCode(...new Uint8Array(mac))),
    },
    body: new URLSearchParams(params).toString(),
  });
}

export const formOf = (body: string) => Object.fromEntries(new URLSearchParams(body));
