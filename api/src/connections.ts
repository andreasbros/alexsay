import type { Context } from "hono";
import { connections } from "./db";
import { accessToken, type LightwaveSecret, type LightwaveUrls } from "./providers/lightwave";
import { type OpenAiSettings, openaiSettings } from "./schemas";
import { open, seal } from "./secrets";
import type { AppEnv } from "./types";

export interface OpenAiConnection {
  apiKey: string;
  settings: OpenAiSettings;
}

/** The user's OpenAI key and settings, or null when they have not connected one. */
export async function openaiConnection(c: Context<AppEnv>, username: string): Promise<OpenAiConnection | null> {
  const row = await connections.get(c.env.DB, username, "openai");
  if (!row) {
    return null;
  }
  const { api_key } = await open<{ api_key: string }>(c.env.SECRETS_KEY, row.secret);
  return { apiKey: api_key, settings: openaiSettings.parse(JSON.parse(row.settings)) };
}

export function lightwaveUrls(c: Context<AppEnv>): LightwaveUrls {
  return { auth: c.env.LIGHTWAVE_AUTH_URL, base: c.env.LIGHTWAVE_BASE_URL };
}

/** A valid Lightwave access token; a refresh stores the rotated refresh token before anything else runs. */
export async function lightwaveToken(c: Context<AppEnv>, username: string): Promise<string | null> {
  const row = await connections.get(c.env.DB, username, "lightwave");
  if (!row) {
    return null;
  }
  const secret = await open<LightwaveSecret>(c.env.SECRETS_KEY, row.secret);
  const result = await accessToken(lightwaveUrls(c), secret);
  if (result.refreshed) {
    await connections.setSecret(c.env.DB, username, "lightwave", await seal(c.env.SECRETS_KEY, result.secret));
  }
  return result.token;
}
