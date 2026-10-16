import { connections } from "./db";
import { accessToken, type LightwaveSecret, type LightwaveUrls } from "./providers/lightwave";
import { ProviderError } from "./providers/openai";
import { type SpotifySecret, type SpotifyUrls, accessToken as spotifyAccessToken } from "./providers/spotify";
import { createApiKey, type TwilioClient, type TwilioSecret } from "./providers/twilio";
import {
  type OpenAiSettings,
  openaiSettings,
  type SpotifySettings,
  spotifySettings,
  type TwilioSettings,
  twilioSettings,
} from "./schemas";
import { open, seal } from "./secrets";
import type { ConnectionRow, Scope } from "./types";

export interface OpenAiSecret {
  api_key: string;
  webhook_secret?: string;
}

export interface OpenAiConnection {
  apiKey: string;
  /** Signs the project's realtime.call.incoming webhooks; present once phone calls are set up. */
  webhookSecret: string | null;
  settings: OpenAiSettings;
}

/** The user's OpenAI key and settings, or null when they have not connected one. */
export async function openaiConnection(c: Scope, home: string): Promise<OpenAiConnection | null> {
  const row = await connections.get(c.env.DB, home, "openai");
  if (!row) {
    return null;
  }
  const secret = await open<OpenAiSecret>(c.env.SECRETS_KEY, row.secret);
  return {
    apiKey: secret.api_key,
    webhookSecret: secret.webhook_secret ?? null,
    settings: openaiSettings.parse(JSON.parse(row.settings)),
  };
}

/** The assistant can join phone calls once the project id and the webhook secret are both in place. */
export const canJoinCalls = (openai: OpenAiConnection | null): openai is OpenAiConnection =>
  !!openai && !!openai.settings.project_id && !!openai.webhookSecret;

export function lightwaveUrls(c: Scope): LightwaveUrls {
  return { auth: c.env.LIGHTWAVE_AUTH_URL, base: c.env.LIGHTWAVE_BASE_URL };
}

/**
 * A valid Lightwave access token; a refresh stores the rotated refresh token before anything else runs.
 * Refresh tokens are single use, so when two requests race the loser re-reads what the winner stored.
 */
export async function lightwaveToken(c: Scope, home: string): Promise<string | null> {
  const row = await connections.get(c.env.DB, home, "lightwave");
  if (!row) {
    return null;
  }
  try {
    return await refreshAndStore(c, home, row.secret);
  } catch (err) {
    const latest = await connections.get(c.env.DB, home, "lightwave");
    if (err instanceof ProviderError && latest && latest.secret !== row.secret) {
      return refreshAndStore(c, home, latest.secret);
    }
    throw err;
  }
}

async function refreshAndStore(c: Scope, home: string, sealed: string): Promise<string> {
  const secret = await open<LightwaveSecret>(c.env.SECRETS_KEY, sealed);
  const result = await accessToken(lightwaveUrls(c), secret);
  if (result.refreshed) {
    await connections.setSecret(c.env.DB, home, "lightwave", await seal(c.env.SECRETS_KEY, result.secret));
  }
  return result.token;
}

/** Exchanges freshly pasted Lightwave tokens right away, so a dead refresh token is caught before it is stored. */
export async function exchangeLightwave(c: Scope, secret: LightwaveSecret): Promise<LightwaveSecret> {
  return (await accessToken(lightwaveUrls(c), secret)).secret;
}

export interface TwilioConnection {
  client: TwilioClient;
  settings: TwilioSettings;
}

/** The user's Twilio account and telephony settings, or null when they have not connected one. */
export async function twilioConnection(c: Scope, home: string): Promise<TwilioConnection | null> {
  const row = await connections.get(c.env.DB, home, "twilio");
  return row ? twilioFromRow(c, row) : null;
}

export async function twilioFromRow(c: Scope, row: ConnectionRow): Promise<TwilioConnection> {
  const secret = await open<TwilioSecret>(c.env.SECRETS_KEY, row.secret);
  return {
    client: { baseUrl: c.env.TWILIO_BASE_URL, secret },
    settings: twilioSettings.parse(JSON.parse(row.settings)),
  };
}

const DEFAULT_COUNTRY_CODE = "+44";

/** The dialling code assumed for local numbers: the Twilio setting when there is one. */
export async function countryCode(c: Scope, home: string): Promise<string> {
  const row = await connections.get(c.env.DB, home, "twilio");
  return row ? twilioSettings.parse(JSON.parse(row.settings)).country_code : DEFAULT_COUNTRY_CODE;
}

/** The API key that signs browser voice tokens, created and sealed on first use. */
export async function twilioSigningKey(
  c: Scope,
  home: string,
  connection: TwilioConnection,
): Promise<Required<Pick<TwilioSecret, "account_sid" | "api_key_sid" | "api_key_secret">>> {
  const { secret } = connection.client;
  if (secret.api_key_sid && secret.api_key_secret) {
    return { account_sid: secret.account_sid, api_key_sid: secret.api_key_sid, api_key_secret: secret.api_key_secret };
  }
  const key = await createApiKey(connection.client);
  const next: TwilioSecret = { ...secret, api_key_sid: key.sid, api_key_secret: key.secret };
  await connections.setSecret(c.env.DB, home, "twilio", await seal(c.env.SECRETS_KEY, next));
  return { account_sid: secret.account_sid, api_key_sid: key.sid, api_key_secret: key.secret };
}

export function spotifyUrls(c: Scope): SpotifyUrls {
  return { accounts: c.env.SPOTIFY_ACCOUNTS_URL, base: c.env.SPOTIFY_BASE_URL };
}

export interface SpotifyConnection {
  secret: SpotifySecret;
  settings: SpotifySettings;
}

/** The home's Spotify app and account state, or null when none was saved. */
export async function spotifyConnection(c: Scope, home: string): Promise<SpotifyConnection | null> {
  const row = await connections.get(c.env.DB, home, "spotify");
  if (!row) {
    return null;
  }
  return {
    secret: await open<SpotifySecret>(c.env.SECRETS_KEY, row.secret),
    settings: spotifySettings.parse(JSON.parse(row.settings)),
  };
}

/** Whether the music tools exist: a Spotify account has signed in. */
export async function spotifyReady(c: Scope, home: string): Promise<boolean> {
  const row = await connections.get(c.env.DB, home, "spotify");
  return row !== null && spotifySettings.parse(JSON.parse(row.settings)).authorized;
}

/**
 * A valid Spotify access token, or null when no account is signed in. A refresh stores the new
 * tokens first; when two requests race, the loser re-reads what the winner stored.
 */
export async function spotifyToken(c: Scope, home: string): Promise<string | null> {
  const row = await connections.get(c.env.DB, home, "spotify");
  if (!row) {
    return null;
  }
  const secret = await open<SpotifySecret>(c.env.SECRETS_KEY, row.secret);
  if (!secret.refresh_token) {
    return null;
  }
  try {
    return await refreshSpotify(c, home, secret);
  } catch (err) {
    const latest = await connections.get(c.env.DB, home, "spotify");
    if (err instanceof ProviderError && latest && latest.secret !== row.secret) {
      return refreshSpotify(c, home, await open<SpotifySecret>(c.env.SECRETS_KEY, latest.secret));
    }
    throw err;
  }
}

async function refreshSpotify(c: Scope, home: string, secret: SpotifySecret): Promise<string> {
  const result = await spotifyAccessToken(spotifyUrls(c), secret);
  if (result.refreshed) {
    await connections.setSecret(c.env.DB, home, "spotify", await seal(c.env.SECRETS_KEY, result.secret));
  }
  return result.token;
}
