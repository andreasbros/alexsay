export type Role = "admin" | "user";
export type Provider = "openai" | "lightwave";

export interface User {
  username: string;
  role: Role;
  created_at?: number;
  devices?: number;
}

export interface Device {
  id: string;
  name: string;
  owner: string | null;
  created_at: number;
  claimed_at: number | null;
  last_seen_at: number | null;
  firmware: string | null;
  online: boolean;
}

export interface OpenAiSettings {
  model: string;
  backend_model: string;
  voice: string;
  instructions: string;
}

export interface Connection {
  provider: Provider;
  settings: Partial<OpenAiSettings>;
  created_at: number;
  updated_at: number;
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

export interface ProviderTest {
  ok: boolean;
  models?: number;
  live_model?: boolean;
  backend_model?: boolean;
  structures?: number;
  status?: number;
  detail?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new ApiError(res.status, error.error ?? res.statusText, error.detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  me: () => request<User>("GET", "/api/session/me"),
  login: (username: string, password: string) => request<User>("POST", "/api/session/login", { username, password }),
  register: (username: string, password: string) =>
    request<User>("POST", "/api/session/register", { username, password }),
  logout: () => request<void>("POST", "/api/session/logout"),

  devices: () => request<Device[]>("GET", "/api/devices"),
  addDevice: (id: string, name: string) => request<Device>("POST", "/api/devices", { id, name }),
  updateDevice: (id: string, changes: { name?: string; owner?: string | null }) =>
    request<void>("PATCH", `/api/devices/${encodeURIComponent(id)}`, changes),
  removeDevice: (id: string) => request<void>("DELETE", `/api/devices/${encodeURIComponent(id)}`),

  connections: () => request<Connection[]>("GET", "/api/connections"),
  connectOpenai: (api_key: string, settings: OpenAiSettings) =>
    request<Connection>("PUT", "/api/connections/openai", { api_key, settings }),
  connectLightwave: (basic_token: string, refresh_token: string) =>
    request<Connection>("PUT", "/api/connections/lightwave", { basic_token, refresh_token }),
  testConnection: (provider: Provider) => request<ProviderTest>("POST", `/api/connections/${provider}/test`),
  removeConnection: (provider: Provider) => request<void>("DELETE", `/api/connections/${provider}`),

  assistantSession: (sdp: string) =>
    request<{ session_id: string; sdp: string; tools: string[] }>("POST", "/api/assistant/sessions", { sdp }),

  lights: () => request<Light[]>("GET", "/api/lightwave/lights"),
  setFeature: (featureId: string, value: number) =>
    request<void>("POST", `/api/lightwave/features/${encodeURIComponent(featureId)}`, { value }),

  users: () => request<User[]>("GET", "/api/users"),
  setRole: (username: string, role: Role) =>
    request<void>("PATCH", `/api/users/${encodeURIComponent(username)}`, { role }),
  removeUser: (username: string) => request<void>("DELETE", `/api/users/${encodeURIComponent(username)}`),
};
