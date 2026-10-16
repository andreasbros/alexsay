import { ProviderError } from "./openai";

/**
 * What sits sealed in D1: the home's own Spotify app (client id and secret from the developer
 * dashboard) and, once the account is signed in, its refresh token; the access token is a cache.
 */
export interface SpotifySecret {
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  access_token?: string;
  access_expires_at?: number;
}

export interface SpotifyUrls {
  /** accounts.spotify.com: the sign-in page and the token endpoint. */
  accounts: string;
  /** api.spotify.com/v1: the Web API. */
  base: string;
}

/** Everything the assistant does: read playlists and the library, see and steer playback. */
export const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  // `/me` only carries `product` (the plan) with this scope; without it every account looks free
  "user-read-private",
];

export interface SpotifyAccount {
  id: string;
  display_name: string;
  product: string;
  country: string;
}

export interface Playlist {
  id: string;
  name: string;
  uri: string;
  tracks: number;
  owner: string;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
}

export interface Playable {
  uri: string;
  name: string;
  kind: "track" | "album" | "artist" | "playlist";
  by: string;
}

export interface PlayerState {
  is_playing: boolean;
  device: { id: string; name: string } | null;
  item: { name: string; by: string; album: string; duration_ms: number } | null;
  progress_ms: number | null;
  context: { type: string; uri: string } | null;
}

const EXPIRY_MARGIN_MS = 60_000;

const basic = (secret: SpotifySecret) => `Basic ${btoa(`${secret.client_id}:${secret.client_secret}`)}`;

/** The page the user is sent to; Spotify comes back to `redirectUri` with `code` and the same `state`. */
export function authorizeUrl(urls: SpotifyUrls, clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES.join(" "),
    redirect_uri: redirectUri,
    state,
  });
  return `${urls.accounts}/authorize?${params}`;
}

/** Turns the code from the sign-in redirect into tokens; the refresh token goes into the sealed secret. */
export async function exchangeCode(
  urls: SpotifyUrls,
  secret: SpotifySecret,
  code: string,
  redirectUri: string,
  now = Date.now(),
): Promise<SpotifySecret> {
  const body = await tokenRequest(urls, secret, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!body.refresh_token) {
    throw new ProviderError(502, "Spotify returned no refresh token");
  }
  return {
    client_id: secret.client_id,
    client_secret: secret.client_secret,
    refresh_token: body.refresh_token,
    access_token: body.access_token,
    access_expires_at: now + (body.expires_in ?? 3600) * 1000,
  };
}

/** A valid access token, refreshed when missing or about to expire; the caller persists the new secret. */
export async function accessToken(
  urls: SpotifyUrls,
  secret: SpotifySecret,
  now = Date.now(),
): Promise<{ token: string; secret: SpotifySecret; refreshed: boolean }> {
  if (!secret.refresh_token) {
    throw new ProviderError(401, "the Spotify account is not signed in yet");
  }
  if (secret.access_token && (secret.access_expires_at ?? 0) > now + EXPIRY_MARGIN_MS) {
    return { token: secret.access_token, secret, refreshed: false };
  }
  const body = await tokenRequest(urls, secret, { grant_type: "refresh_token", refresh_token: secret.refresh_token });
  const next: SpotifySecret = {
    ...secret,
    // Spotify hands out a new refresh token now and then; the old one keeps working until it does
    refresh_token: body.refresh_token ?? secret.refresh_token,
    access_token: body.access_token,
    access_expires_at: now + (body.expires_in ?? 3600) * 1000,
  };
  return { token: body.access_token, secret: next, refreshed: true };
}

async function tokenRequest(
  urls: SpotifyUrls,
  secret: SpotifySecret,
  form: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(`${urls.accounts}/api/token`, {
    method: "POST",
    headers: { authorization: basic(secret), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await describe(res, "token request failed"));
  }
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
}

async function api<T>(urls: SpotifyUrls, token: string, path: string, init: RequestInit = {}): Promise<T | null> {
  const res = await fetch(`${urls.base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await describe(res, res.statusText));
  }
  // Playback commands answer 204; so does the player when nothing is playing
  if (res.status === 204) {
    return null;
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

/** Spotify's own reason or message when it gave one, otherwise the status text; never a token. */
async function describe(res: Response, fallback: string): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 400);
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string; reason?: string };
      error_description?: string;
    };
    if (typeof parsed.error === "object" && parsed.error) {
      return parsed.error.reason ?? parsed.error.message ?? fallback;
    }
    return parsed.error_description ?? (typeof parsed.error === "string" ? parsed.error : text) ?? fallback;
  } catch {
    return text || fallback;
  }
}

export async function me(urls: SpotifyUrls, token: string): Promise<SpotifyAccount> {
  const body = await api<{ id: string; display_name: string | null; product?: string; country?: string }>(
    urls,
    token,
    "/me",
  );
  return {
    id: body?.id ?? "",
    display_name: body?.display_name ?? body?.id ?? "",
    product: body?.product ?? "",
    country: body?.country ?? "",
  };
}

const PLAYLIST_PAGES = 4;

/** The account's playlists, own and followed, up to 200. */
export async function playlists(urls: SpotifyUrls, token: string): Promise<Playlist[]> {
  const all: Playlist[] = [];
  for (let page = 0; page < PLAYLIST_PAGES; page += 1) {
    const body = await api<{
      items: ({
        id: string;
        name: string;
        uri: string;
        tracks?: { total: number };
        owner?: { display_name?: string };
      } | null)[];
      next: string | null;
    }>(urls, token, `/me/playlists?limit=50&offset=${page * 50}`);
    for (const item of body?.items ?? []) {
      if (item) {
        all.push({
          id: item.id,
          name: item.name,
          uri: item.uri,
          tracks: item.tracks?.total ?? 0,
          owner: item.owner?.display_name ?? "",
        });
      }
    }
    if (!body?.next) {
      break;
    }
  }
  return all;
}

export async function devices(urls: SpotifyUrls, token: string): Promise<SpotifyDevice[]> {
  const body = await api<{ devices: (SpotifyDevice & { id: string | null })[] }>(urls, token, "/me/player/devices");
  return (body?.devices ?? []).filter((d): d is SpotifyDevice => typeof d.id === "string");
}

export async function playerState(urls: SpotifyUrls, token: string): Promise<PlayerState | null> {
  const body = await api<{
    is_playing: boolean;
    device?: { id: string | null; name: string };
    progress_ms?: number | null;
    item?: {
      name: string;
      duration_ms: number;
      artists?: { name: string }[];
      album?: { name: string };
      show?: { name: string };
    } | null;
    context?: { type: string; uri: string } | null;
  }>(urls, token, "/me/player");
  if (!body) {
    return null;
  }
  return {
    is_playing: body.is_playing,
    device: body.device?.id ? { id: body.device.id, name: body.device.name } : null,
    item: body.item
      ? {
          name: body.item.name,
          by: (body.item.artists ?? []).map((a) => a.name).join(", ") || (body.item.show?.name ?? ""),
          album: body.item.album?.name ?? "",
          duration_ms: body.item.duration_ms,
        }
      : null,
    progress_ms: body.progress_ms ?? null,
    context: body.context ?? null,
  };
}

export type SearchKind = Playable["kind"];

/** The best few matches of each kind asked for; Spotify's own ranking, in its order. */
export async function search(
  urls: SpotifyUrls,
  token: string,
  query: string,
  kinds: SearchKind[],
): Promise<Playable[]> {
  const params = new URLSearchParams({ q: query, type: kinds.join(","), limit: "5", market: "from_token" });
  interface Hit {
    uri: string;
    name: string;
    artists?: { name: string }[];
    owner?: { display_name?: string };
  }
  const body = await api<{
    tracks?: { items: (Hit | null)[] };
    albums?: { items: (Hit | null)[] };
    artists?: { items: (Hit | null)[] };
    playlists?: { items: (Hit | null)[] };
  }>(urls, token, `/search?${params}`);
  const found: Playable[] = [];
  for (const kind of kinds) {
    const items =
      kind === "track"
        ? body?.tracks?.items
        : kind === "album"
          ? body?.albums?.items
          : kind === "artist"
            ? body?.artists?.items
            : body?.playlists?.items;
    for (const item of items ?? []) {
      if (!item) {
        continue;
      }
      const artists = (item.artists ?? []).map((a) => a.name).join(", ");
      found.push({ uri: item.uri, name: item.name, kind, by: artists || (item.owner?.display_name ?? "") });
    }
  }
  return found;
}

const onDevice = (deviceId: string | null) => (deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "");

/** Starts something (a context, or these tracks) on a device; with neither, resumes what was paused. */
export async function play(
  urls: SpotifyUrls,
  token: string,
  deviceId: string | null,
  what: { context_uri?: string; uris?: string[] } | null,
): Promise<void> {
  await api(urls, token, `/me/player/play${onDevice(deviceId)}`, {
    method: "PUT",
    body: what ? JSON.stringify(what) : undefined,
  });
}

export async function pause(urls: SpotifyUrls, token: string, deviceId: string | null): Promise<void> {
  await api(urls, token, `/me/player/pause${onDevice(deviceId)}`, { method: "PUT" });
}

export async function skip(
  urls: SpotifyUrls,
  token: string,
  deviceId: string | null,
  direction: "next" | "previous",
): Promise<void> {
  await api(urls, token, `/me/player/${direction}${onDevice(deviceId)}`, { method: "POST" });
}

export async function setVolume(
  urls: SpotifyUrls,
  token: string,
  deviceId: string | null,
  percent: number,
): Promise<void> {
  const params = new URLSearchParams({ volume_percent: String(Math.round(percent)) });
  if (deviceId) {
    params.set("device_id", deviceId);
  }
  await api(urls, token, `/me/player/volume?${params}`, { method: "PUT" });
}

/** Moves playback to a device, continuing or starting it there. */
export async function transfer(urls: SpotifyUrls, token: string, deviceId: string, playNow: boolean): Promise<void> {
  await api(urls, token, "/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play: playNow }),
  });
}
