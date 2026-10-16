import { spotifyConnection, spotifyUrls } from "./connections";
import { constantTimeEqual, fromBase64Url, toBase64Url, toHex } from "./crypto";
import { connections, devices } from "./db";
import { exchangeCode, me, type SpotifyDevice } from "./providers/spotify";
import { type SpotifySettings, spotifySettings } from "./schemas";
import { seal } from "./secrets";
import type { Scope, ToolContext } from "./types";

/** How long the sign-in page may take before the state token the user comes back with is stale. */
const STATE_TTL_MS = 10 * 60_000;

/** Where Spotify sends the browser back; registered word for word in the Spotify app's settings. */
export const redirectUri = (origin: string) => `${origin}/api/connections/spotify/callback`;

const encoder = new TextEncoder();

async function sign(keyHex: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(keyHex), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}

/** The OAuth `state`: which home started the sign-in and until when, signed so nothing is stored. */
export async function loginState(env: Env, home: string, now: number): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ home, exp: now + STATE_TTL_MS })));
  return `${body}.${await sign(env.SECRETS_KEY, body)}`;
}

/** The home a valid, unexpired state was made for; null for anything else. */
export async function homeOfState(env: Env, state: string, now: number): Promise<string | null> {
  const [body, signature] = state.split(".");
  if (!body || !signature || !constantTimeEqual(signature, await sign(env.SECRETS_KEY, body))) {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { home?: string; exp?: number };
    return typeof parsed.home === "string" && (parsed.exp ?? 0) > now ? parsed.home : null;
  } catch {
    return null;
  }
}

/** The browser came back with a code: tokens are exchanged and the account's name and plan recorded. */
export async function completeLogin(
  scope: Scope & { origin: string },
  home: string,
  code: string,
): Promise<SpotifySettings> {
  const connection = await spotifyConnection(scope, home);
  if (!connection) {
    throw new Error("no Spotify app saved for this home");
  }
  const urls = spotifyUrls(scope);
  const secret = await exchangeCode(urls, connection.secret, code, redirectUri(scope.origin));
  const account = await me(urls, secret.access_token ?? "");
  const settings = spotifySettings.parse({
    authorized: true,
    account: account.display_name,
    premium: account.product.startsWith("premium"),
    market: account.country,
  });
  await connections.put(
    scope.env.DB,
    home,
    "spotify",
    await seal(scope.env.SECRETS_KEY, secret),
    JSON.stringify(settings),
  );
  return settings;
}

const simplify = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");

/** A Spotify Connect device by name: exact first, then one whose name contains or is contained in the words. */
export function deviceNamed(all: SpotifyDevice[], name: string): SpotifyDevice | undefined {
  const wanted = simplify(name);
  if (!wanted) {
    return undefined;
  }
  return (
    all.find((d) => simplify(d.name) === wanted) ??
    all.find((d) => simplify(d.name).includes(wanted) || wanted.includes(simplify(d.name)))
  );
}

/**
 * Where music should play: the speaker the user named, else the speaker they are talking from, else
 * whatever Spotify is playing on now, else the only device there is. Several and no hint: the model asks.
 */
export async function targetDevice(
  c: ToolContext,
  all: SpotifyDevice[],
  speaker: string,
): Promise<SpotifyDevice | { error: string }> {
  const names = all.map((d) => d.name);
  if (speaker) {
    return (
      deviceNamed(all, speaker) ?? {
        error: names.length
          ? `no Spotify device is called ${speaker}; the ones available: ${names.join(", ")}`
          : `no Spotify device is called ${speaker}: none is open right now`,
      }
    );
  }
  if (c.device) {
    const row = await devices.get(c.env.DB, c.device);
    const own = row ? deviceNamed(all, row.name) : undefined;
    if (own) {
      return own;
    }
  }
  const active = all.find((d) => d.is_active);
  if (active) {
    return active;
  }
  if (all.length === 1 && all[0]) {
    return all[0];
  }
  if (all.length === 0) {
    return { error: "no Spotify device is open: open Spotify on a phone, computer or speaker first" };
  }
  return { error: `nothing is playing; ask which device: ${names.join(", ")}` };
}
