import { Hono } from "hono";
import { spotifyToken, spotifyUrls } from "../connections";
import { ProviderError } from "../providers/openai";
import { pause, play, playerState, skip } from "../providers/spotify";
import * as schemas from "../schemas";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/** What the home's music service is playing, as the app shows it under a speaker. */
export interface NowPlaying {
  is_playing: boolean;
  track: string;
  by: string;
  album: string;
  /** The playing device's name as the service knows it: a speaker's name when it is one of ours. */
  device: string | null;
}

/** The app's view of music: Spotify today, through the same shape any later service would fill. */
export const musicRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const token = await spotifyToken(c, c.get("user").home);
    if (!token) {
      return c.json({ connected: false, playing: null });
    }
    try {
      const state = await playerState(spotifyUrls(c), token);
      const playing: NowPlaying | null = state?.item
        ? {
            is_playing: state.is_playing,
            track: state.item.name,
            by: state.item.by,
            album: state.item.album,
            device: state.device?.name ?? null,
          }
        : null;
      return c.json({ connected: true, playing });
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: "music_service", detail: err.detail }, 502);
      }
      throw err;
    }
  })
  .post("/", async (c) => {
    const { action } = await jsonBody(c, schemas.musicAction);
    const token = await spotifyToken(c, c.get("user").home);
    if (!token) {
      return c.json({ error: "not_connected" }, 404);
    }
    const urls = spotifyUrls(c);
    try {
      if (action === "pause") {
        await pause(urls, token, null);
      } else if (action === "play") {
        await play(urls, token, null, null);
      } else {
        await skip(urls, token, null, action);
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: "music_service", detail: err.detail }, 502);
      }
      throw err;
    }
    return c.json({ ok: true });
  });
