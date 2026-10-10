import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { hashPassword } from "../src/crypto";

export const APP = "https://app.alexsay.com";
export const DEVICE_ID = "7d1d6e2e-7c7b-4f6a-9d0a-1d2e3f4a5b6c";

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["connections", "devices", "sessions", "login_failures", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
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
  if (init.body) {
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
    const handler = routes[key];
    if (!handler) {
      throw new Error(`unexpected upstream call ${key}`);
    }
    pending.delete(key);
    calls.push(req.clone());
    return handler(req, await req.text());
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
