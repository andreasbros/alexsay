import { spotifyToken, spotifyUrls } from "./connections";
import { ProviderError } from "./providers/openai";
import {
  devices as listDevices,
  type Playable,
  pause,
  play,
  playerState,
  playlists,
  type SearchKind,
  search,
  setVolume,
  skip,
  transfer,
} from "./providers/spotify";
import { targetDevice } from "./spotify";
import type { Tool } from "./tools";
import type { ToolContext } from "./types";

const NOT_CONNECTED = "Spotify is not connected: the home's admin signs in under Connections";

/** Plays, pauses and browses Spotify through the Web API; the speaker is a Spotify Connect device like any other. */
export const MUSIC_TOOLS: Tool[] = [
  {
    needs: "spotify",
    definition: {
      type: "function",
      name: "list_playlists",
      description: "The user's Spotify playlists, own and followed, with how many tracks each has.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: (c) =>
      withSpotify(c, async (token) =>
        (await playlists(spotifyUrls(c), token)).map((p) => ({ name: p.name, tracks: p.tracks, owner: p.owner })),
      ),
  },
  {
    needs: "spotify",
    definition: {
      type: "function",
      name: "play_music",
      description:
        "Plays music on Spotify: a playlist by name, or a song, album or artist found by search. Without a query " +
        "it resumes what was paused. It plays on the speaker the user is talking from by default; name another " +
        "speaker or device only when the user asks for one.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to play: a playlist, song, album or artist name" },
          kind: {
            type: "string",
            enum: ["any", "playlist", "track", "album", "artist"],
            description: 'What the query names, when the user said ("the album", "my playlist"); default any',
          },
          speaker: { type: "string", description: "A speaker or device to play on, only when the user named one" },
        },
        additionalProperties: false,
      },
    },
    run: (c, args) =>
      withSpotify(c, async (token) => {
        const urls = spotifyUrls(c);
        const target = await targetDevice(c, await listDevices(urls, token), text(args, "speaker"));
        if ("error" in target) {
          return target;
        }
        const query = text(args, "query");
        if (!query) {
          return resume(urls, token, target.id, target.name);
        }
        const kind = kindOf(args);
        const found = await find(urls, token, query, kind);
        if (!found) {
          return { error: `nothing on Spotify matches ${query}` };
        }
        await play(urls, token, target.id, found.kind === "track" ? { uris: [found.uri] } : { context_uri: found.uri });
        return { playing: found.name, kind: found.kind, by: found.by, on: target.name };
      }),
  },
  {
    needs: "spotify",
    definition: {
      type: "function",
      name: "pause_music",
      description: "Pauses or stops Spotify playback.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: (c) =>
      withSpotify(c, async (token) => {
        const urls = spotifyUrls(c);
        const state = await playerState(urls, token);
        if (!state?.is_playing) {
          return { paused: false, note: "nothing was playing" };
        }
        await pause(urls, token, state.device?.id ?? null);
        return { paused: true, on: state.device?.name ?? "" };
      }),
  },
  {
    needs: "spotify",
    definition: {
      type: "function",
      name: "skip_track",
      description: "Skips to the next track, or back to the previous one.",
      parameters: {
        type: "object",
        properties: { direction: { type: "string", enum: ["next", "previous"], description: "Default next" } },
        additionalProperties: false,
      },
    },
    run: (c, args) =>
      withSpotify(c, async (token) => {
        const urls = spotifyUrls(c);
        const direction = text(args, "direction") === "previous" ? "previous" : "next";
        await skip(urls, token, null, direction);
        const state = await playerState(urls, token);
        return { skipped: direction, now: state?.item ? `${state.item.name} by ${state.item.by}` : null };
      }),
  },
  {
    needs: "spotify",
    definition: {
      type: "function",
      name: "now_playing",
      description: "What Spotify is playing right now and where, if anything.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: (c) =>
      withSpotify(c, async (token) => {
        const state = await playerState(spotifyUrls(c), token);
        if (!state?.item) {
          return { playing: false };
        }
        return {
          playing: state.is_playing,
          track: state.item.name,
          by: state.item.by,
          album: state.item.album,
          on: state.device?.name ?? "",
        };
      }),
  },
  {
    needs: "spotify",
    definition: {
      type: "function",
      name: "set_music_volume",
      description: "Sets the Spotify playback volume, 0 to 100, on the device that is playing.",
      parameters: {
        type: "object",
        properties: { percent: { type: "integer", minimum: 0, maximum: 100 } },
        required: ["percent"],
        additionalProperties: false,
      },
    },
    run: (c, args) =>
      withSpotify(c, async (token) => {
        const percent = typeof args.percent === "number" ? Math.max(0, Math.min(100, args.percent)) : null;
        if (percent === null) {
          return { error: "percent is required" };
        }
        await setVolume(spotifyUrls(c), token, null, percent);
        return { volume: percent };
      }),
  },
];

const text = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";

const KINDS: readonly SearchKind[] = ["playlist", "track", "album", "artist"];

const kindOf = (args: Record<string, unknown>): SearchKind | "any" => {
  const kind = text(args, "kind");
  return KINDS.includes(kind as SearchKind) ? (kind as SearchKind) : "any";
};

/** Spotify's playback errors in words the model can pass on; anything else is reported as it came. */
async function withSpotify(c: ToolContext, run: (token: string) => Promise<unknown>): Promise<unknown> {
  const token = await spotifyToken(c, c.user.home);
  if (!token) {
    return { error: NOT_CONNECTED };
  }
  try {
    return await run(token);
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.status === 403 && /premium/i.test(err.detail)) {
        return { error: "Spotify Premium is needed to control playback; this account is not Premium" };
      }
      if (err.status === 404 && /device/i.test(err.detail)) {
        return { error: "no Spotify device is active: open Spotify on a phone, computer or speaker first" };
      }
    }
    throw err;
  }
}

/** Resumes on the device; when Spotify has no active player, playback is moved there first. */
async function resume(urls: ReturnType<typeof spotifyUrls>, token: string, deviceId: string, name: string) {
  try {
    await play(urls, token, deviceId, null);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 404) {
      await transfer(urls, token, deviceId, true);
    } else {
      throw err;
    }
  }
  return { resumed: true, on: name };
}

const simplify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");

/**
 * The user's own playlists first (a name they chose beats a search hit), then Spotify's search:
 * the asked-for kind, or the first track when nothing narrower was said.
 */
async function find(
  urls: ReturnType<typeof spotifyUrls>,
  token: string,
  query: string,
  kind: SearchKind | "any",
): Promise<Playable | null> {
  if (kind === "any" || kind === "playlist") {
    const wanted = simplify(query);
    const own = (await playlists(urls, token)).find((p) => {
      const name = simplify(p.name);
      return name === wanted || (wanted.length >= 4 && (name.includes(wanted) || wanted.includes(name)));
    });
    if (own) {
      return { uri: own.uri, name: own.name, kind: "playlist", by: own.owner };
    }
  }
  const kinds: SearchKind[] = kind === "any" ? ["track", "album", "artist", "playlist"] : [kind];
  const found = await search(urls, token, query, kinds);
  if (kind !== "any") {
    return found[0] ?? null;
  }
  // "Play Daft Punk" wants the artist, "play Get Lucky" a track: an artist whose name is the whole query wins
  const wanted = simplify(query);
  return found.find((f) => f.kind === "artist" && simplify(f.name) === wanted) ?? found[0] ?? null;
}
