import { ProviderError } from "./openai";

/** What sits sealed in D1: the refresh token rotates on every use, the access token is a cache. */
export interface LightwaveSecret {
  basic_token: string;
  refresh_token: string;
  access_token?: string;
  access_expires_at?: number;
}

export interface LightwaveUrls {
  auth: string;
  base: string;
}

interface Feature {
  featureId: string;
  type: string;
  writable: boolean;
}

interface Structure {
  structureId: string;
  name: string;
  devices: { deviceId: string; name: string; productCode?: string; featureSets: FeatureSet[] }[];
}

interface FeatureSet {
  featureSetId: string;
  name: string;
  features: Feature[];
}

export interface Light {
  id: string;
  name: string;
  device: string;
  switch: string;
  dim: string | null;
  on: boolean;
  dim_level: number | null;
}

const EXPIRY_MARGIN_MS = 60_000;

/** A short-lived access token, refreshed when missing or about to expire; the caller persists the new secret. */
export async function accessToken(
  urls: LightwaveUrls,
  secret: LightwaveSecret,
  now = Date.now(),
): Promise<{ token: string; secret: LightwaveSecret; refreshed: boolean }> {
  if (secret.access_token && (secret.access_expires_at ?? 0) > now + EXPIRY_MARGIN_MS) {
    return { token: secret.access_token, secret, refreshed: false };
  }
  const res = await fetch(urls.auth, {
    method: "POST",
    headers: { authorization: `basic ${secret.basic_token}`, "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: secret.refresh_token }),
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await describe(res, "token refresh failed"));
  }
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  const next: LightwaveSecret = {
    basic_token: secret.basic_token,
    refresh_token: body.refresh_token,
    access_token: body.access_token,
    access_expires_at: now + (body.expires_in ?? 3600) * 1000,
  };
  return { token: body.access_token, secret: next, refreshed: true };
}

async function api<T>(urls: LightwaveUrls, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${urls.base}${path}`, {
    ...init,
    headers: { authorization: `bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await describe(res, res.statusText));
  }
  return (await res.json()) as T;
}

/** Lightwave answers errors as JSON with error_description or message; fall back to the raw text. */
async function describe(res: Response, fallback: string): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 400);
  try {
    const parsed = JSON.parse(text) as { error_description?: string; message?: string; error?: string };
    return parsed.error_description ?? parsed.message ?? parsed.error ?? text;
  } catch {
    return text || fallback;
  }
}

export async function structureIds(urls: LightwaveUrls, token: string): Promise<string[]> {
  return (await api<{ structures: string[] }>(urls, token, "/structures")).structures;
}

/** Every feature set with a switch, read in one batch so the list comes back with live states. */
export async function lights(urls: LightwaveUrls, token: string): Promise<Light[]> {
  const found: Omit<Light, "on" | "dim_level">[] = [];
  for (const id of await structureIds(urls, token)) {
    const structure = await api<Structure>(urls, token, `/structure/${id}`);
    for (const device of structure.devices) {
      for (const set of device.featureSets) {
        const sw = set.features.find((f) => f.type === "switch" && f.writable);
        if (sw) {
          const dim = set.features.find((f) => f.type === "dimLevel" && f.writable);
          found.push({
            id: set.featureSetId,
            name: set.name,
            device: device.name,
            switch: sw.featureId,
            dim: dim?.featureId ?? null,
          });
        }
      }
    }
  }
  if (found.length === 0) {
    return [];
  }
  const ids = found.flatMap((l) => [l.switch, ...(l.dim ? [l.dim] : [])]);
  const values = await api<Record<string, number>>(urls, token, "/features/read", {
    method: "POST",
    body: JSON.stringify({ features: ids.map((featureId) => ({ featureId })) }),
  });
  return found.map((l) => ({ ...l, on: values[l.switch] === 1, dim_level: l.dim ? (values[l.dim] ?? null) : null }));
}

export async function writeFeature(
  urls: LightwaveUrls,
  token: string,
  featureId: string,
  value: number,
): Promise<void> {
  await api(urls, token, `/feature/${featureId}`, { method: "POST", body: JSON.stringify({ value }) });
}
