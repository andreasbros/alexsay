export type Role = "admin" | "user";
export type Provider = "openai" | "lightwave" | "twilio";

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
  web_search: boolean;
  respond_when_addressed: boolean;
}

export interface TwilioSettings {
  from_number: string;
  whatsapp_from: string;
  my_number: string;
  sip_domain: string;
  country_code: string;
}

export interface PhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  voice: boolean;
  sms: boolean;
}

export interface Connection {
  provider: Provider;
  settings: Partial<OpenAiSettings> & Partial<TwilioSettings>;
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
  account?: string;
  numbers?: number;
  status?: number;
  detail?: string;
}

export type MemoryCategory = "important" | "preferences" | "people" | "home" | "routines" | "reminders" | "facts";
export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "important",
  "preferences",
  "people",
  "home",
  "routines",
  "reminders",
  "facts",
];

export interface Memory {
  id: string;
  category: MemoryCategory;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: string;
  source: "app" | "device";
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  turn_count: number;
}

export interface ConversationTurn {
  at: number;
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  label: string;
  favourite: boolean;
  last_called_at: number | null;
  last_messaged_at: number | null;
  updated_at: number;
}

export interface ContactPage {
  contacts: Contact[];
  total: number;
  page: number;
  page_size: number;
}

export type Channel = "sms" | "whatsapp";

export interface ContactDetail extends Contact {
  messages: { id: string; channel: Channel; direction: "out" | "in"; body: string; status: string; at: number }[];
  calls: {
    id: string;
    direction: "out" | "in";
    kind: "call" | "announcement" | "conference";
    status: string;
    at: number;
  }[];
}

export interface NewContact {
  name: string;
  phone: string;
  label: string;
}

export interface Placed {
  sid: string;
  status: string;
  phone: string;
  contact: string | null;
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
  /** An empty key keeps the one already stored and only updates the settings. */
  connectOpenai: (api_key: string, settings: OpenAiSettings) =>
    request<Connection>("PUT", "/api/connections/openai", { api_key: api_key || undefined, settings }),
  connectLightwave: (basic_token: string, refresh_token: string) =>
    request<Connection>("PUT", "/api/connections/lightwave", { basic_token, refresh_token }),
  /** Empty credentials keep the stored pair; saving with a number points its webhooks at this app. */
  connectTwilio: (account_sid: string, auth_token: string, settings: TwilioSettings) =>
    request<Connection>("PUT", "/api/connections/twilio", {
      account_sid: account_sid || undefined,
      auth_token: auth_token || undefined,
      settings,
    }),
  twilioNumbers: () => request<PhoneNumber[]>("GET", "/api/twilio/numbers"),
  testConnection: (provider: Provider) => request<ProviderTest>("POST", `/api/connections/${provider}/test`),
  removeConnection: (provider: Provider) => request<void>("DELETE", `/api/connections/${provider}`),

  assistantSession: (sdp: string, resumeFrom?: string) =>
    request<{ session_id: string; sdp: string; tools: string[]; resumed: boolean }>("POST", "/api/assistant/sessions", {
      sdp,
      resume_from: resumeFrom,
    }),

  lights: () => request<Light[]>("GET", "/api/lightwave/lights"),
  setFeature: (featureId: string, value: number) =>
    request<void>("POST", `/api/lightwave/features/${encodeURIComponent(featureId)}`, { value }),
  setFeatures: (features: { featureId: string; value: number }[]) =>
    request<void>("POST", "/api/lightwave/features", { features }),

  callTool: (name: string, args: Record<string, unknown>, conversationId: string | null) =>
    request<{ output: unknown }>("POST", "/api/tools/call", {
      name,
      arguments: args,
      conversation_id: conversationId ?? undefined,
    }),

  startConversation: () => request<{ id: string }>("POST", "/api/conversations", { source: "app" }),
  addTurns: (id: string, turns: ConversationTurn[]) =>
    request<void>("POST", `/api/conversations/${encodeURIComponent(id)}/turns`, { turns }),
  endConversation: (id: string) => request<void>("POST", `/api/conversations/${encodeURIComponent(id)}/end`),
  conversations: (q?: string) =>
    request<Conversation[]>("GET", `/api/conversations?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  conversation: (id: string) =>
    request<Conversation & { turns: ConversationTurn[] }>("GET", `/api/conversations/${encodeURIComponent(id)}`),
  removeConversation: (id: string) => request<void>("DELETE", `/api/conversations/${encodeURIComponent(id)}`),

  memories: () => request<Memory[]>("GET", "/api/memories"),
  addMemory: (category: MemoryCategory, content: string) =>
    request<{ id: string }>("POST", "/api/memories", { category, content }),
  updateMemory: (id: string, changes: { category?: MemoryCategory; content?: string }) =>
    request<void>("PATCH", `/api/memories/${encodeURIComponent(id)}`, changes),
  removeMemory: (id: string) => request<void>("DELETE", `/api/memories/${encodeURIComponent(id)}`),

  contacts: (q: string, page: number, favourites: boolean) =>
    request<ContactPage>(
      "GET",
      `/api/contacts?page=${page}&favourites=${favourites ? 1 : 0}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    ),
  contact: (id: string) => request<ContactDetail>("GET", `/api/contacts/${encodeURIComponent(id)}`),
  addContact: (contact: NewContact) => request<Contact>("POST", "/api/contacts", contact),
  importContacts: (contacts: NewContact[]) =>
    request<{ imported: number; updated: number; skipped: number }>("POST", "/api/contacts/import", { contacts }),
  updateContact: (id: string, changes: { name?: string; label?: string; favourite?: boolean }) =>
    request<void>("PATCH", `/api/contacts/${encodeURIComponent(id)}`, changes),
  removeContact: (id: string) => request<void>("DELETE", `/api/contacts/${encodeURIComponent(id)}`),
  placeCall: (contact_id: string, message?: string) =>
    request<Placed>("POST", "/api/twilio/calls", { contact_id, message }),
  sendMessage: (contact_id: string, body: string, channel: Channel) =>
    request<Placed>("POST", "/api/twilio/messages", { contact_id, body, channel }),

  users: () => request<User[]>("GET", "/api/users"),
  setRole: (username: string, role: Role) =>
    request<void>("PATCH", `/api/users/${encodeURIComponent(username)}`, { role }),
  removeUser: (username: string) => request<void>("DELETE", `/api/users/${encodeURIComponent(username)}`),
};
