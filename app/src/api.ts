export type Role = "admin" | "user";
export type Provider = "openai" | "lightwave" | "twilio";

export type HomeRole = "admin" | "user";

export interface User {
  username: string;
  /** Say over the server: admins manage accounts and server settings. */
  role: Role;
  email?: string | null;
  /** The home everything belongs to: its id is its creator's username. */
  home?: string;
  /** Say over the home: admins change its speakers, connections, settings and members. */
  homeRole?: HomeRole;
  created_at?: number;
  devices?: number;
  /** The assistant may read this user's server log. */
  ai_log_access?: boolean;
  /** The assistant may place test calls answered by a scripted AI. */
  ai_call_test?: boolean;
  /** Language and region, such as en-GB: sets the assistant's language, currency and date conventions. */
  locale?: string;
  /** IANA time zone, such as Europe/London: the assistant's clock. */
  timezone?: string;
}

export interface AccountSettings {
  ai_log_access: boolean;
  ai_call_test: boolean;
  locale: string;
  timezone: string;
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
  project_id: string;
  call_model: string;
}

export type VoiceClient = "browser" | "speaker" | "mobile";

export interface NumberRouting {
  sid: string;
  phone_number: string;
  voice_url: string;
  voice_method: string;
  voice_application_sid: string;
  trunk_sid: string;
  sms_url: string;
  sms_method: string;
  sms_application_sid: string;
  status_callback: string;
}

export interface TwilioSettings {
  from_number: string;
  whatsapp_from: string;
  my_number: string;
  sip_domain: string;
  country_code: string;
  /** Set by the server: how the chosen number routed calls before this app took it. */
  number_backup?: NumberRouting | null;
}

export interface PhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  voice: boolean;
  sms: boolean;
  voice_url: string;
  voice_method: string;
  voice_application_sid: string;
  trunk_sid: string;
  sms_url: string;
  sms_method: string;
  sms_application_sid: string;
  status_callback: string;
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

export type MemoryCategory = "important" | "preferences" | "people" | "home" | "routines" | "notes" | "facts";
export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "important",
  "preferences",
  "people",
  "home",
  "routines",
  "notes",
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
  note: string;
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
  note?: string;
}

export interface ContactChanges {
  name?: string;
  phone?: string;
  label?: string;
  note?: string;
  favourite?: boolean;
}

export interface CallParticipant {
  who: string;
  role: string;
  status: string;
  seconds: number;
  answered: boolean;
}

export interface CallReport {
  conference: string;
  started_at: number;
  ended_at: number | null;
  ended_by: string | null;
  /** False while the assistant's leg is still closing: the transcript may be missing its last words. */
  ready: boolean;
  task: string | null;
  seconds: number;
  participants: CallParticipant[];
  transcript: { at: number; speaker: "assistant" | "line"; text: string }[];
}

export interface RecentCall {
  id: string;
  at: number;
  direction: "out" | "in";
  kind: "call" | "announcement" | "conference";
  role: string;
  phone: string;
  contact: string | null;
  status: string;
  detail: string | null;
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

export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export type AlarmKind = "alarm" | "timer" | "reminder";

export interface Alarm {
  id: string;
  kind: AlarmKind;
  label: string;
  message: string;
  enabled: boolean;
  next_at: number | null;
  /** The next ring in the user's zone and language, such as "Wed 15 Oct, 07:00". */
  when: string | null;
  /** "weekdays at 07:00", or null for a one-off. */
  repeat: string | null;
  snoozed: boolean;
  device_id: string | null;
  speaker: string | null;
}

export interface AlarmEvent {
  alarm_id: string;
  kind: AlarmKind | null;
  label: string;
  event: "stopped" | "snoozed" | "missed";
  at: number;
  when: string | null;
  speaker: string | null;
  detail: string;
}

export interface AlarmsPage {
  alarms: Alarm[];
  recent: AlarmEvent[];
  speakers: { id: string; name: string }[];
  timezone: string;
}

export interface AuthConfig {
  email_login: boolean;
  registration: boolean;
  /** Turnstile site key when sign-in email needs a human check first. */
  captcha: string | null;
}

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invite {
  id: string;
  email: string;
  role: HomeRole;
  invited_by: string;
  status: InviteStatus;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
}

export interface HomeMember {
  username: string;
  email: string | null;
  role: HomeRole;
  creator: boolean;
}

export interface Home {
  id: string;
  name: string;
  role: HomeRole;
  creator: boolean;
  members: HomeMember[];
  invites: Invite[];
  can_invite: boolean;
}

export interface InviteInfo {
  home: string;
  invited_by: string;
  email: string;
  role: HomeRole;
}

export interface ServerSettings {
  email_login: boolean;
  mail: { through: string; from: string } | null;
}

export const api = {
  me: () => request<User>("GET", "/api/session/me"),
  login: (username: string, password: string, captcha?: string) =>
    request<User>("POST", "/api/session/login", { username, password, captcha }),
  register: (username: string, password: string, captcha?: string) =>
    request<User>("POST", "/api/session/register", { username, password, captcha }),
  logout: () => request<void>("POST", "/api/session/logout"),
  authConfig: () => request<AuthConfig>("GET", "/api/session/config"),
  emailStart: (email: string, captcha?: string) =>
    request<{ sent: boolean }>("POST", "/api/session/email/start", { email, captcha }),
  emailVerify: (email: string, code: string) => request<User>("POST", "/api/session/email/verify", { email, code }),
  emailLink: (token: string) => request<User>("POST", "/api/session/email/link", { token }),
  addEmail: (email: string) => request<{ sent: boolean }>("POST", "/api/session/email/add", { email }),
  confirmEmail: (code: string) => request<{ email: string }>("POST", "/api/session/email/confirm", { code }),
  removeEmail: () => request<void>("DELETE", "/api/session/email"),
  home: () => request<Home>("GET", "/api/home"),
  renameHome: (name: string) => request<{ name: string }>("PATCH", "/api/home", { name }),
  setMemberRole: (username: string, role: HomeRole) =>
    request<void>("PATCH", `/api/home/members/${encodeURIComponent(username)}`, { role }),
  removeMember: (username: string) => request<void>("DELETE", `/api/home/members/${encodeURIComponent(username)}`),
  leaveHome: () => request<void>("POST", "/api/home/leave"),
  invite: (email: string, role: HomeRole) => request<Invite>("POST", "/api/home/invites", { email, role }),
  resendInvite: (id: string) => request<Invite>("POST", `/api/home/invites/${encodeURIComponent(id)}/resend`),
  removeInvite: (id: string) => request<void>("DELETE", `/api/home/invites/${encodeURIComponent(id)}`),
  inviteInfo: (token: string) => request<InviteInfo>("POST", "/api/invites/lookup", { token }),
  acceptInvite: (token: string) => request<User>("POST", "/api/invites/accept", { token }),
  serverSettings: () => request<ServerSettings>("GET", "/api/server"),
  updateServerSettings: (changes: { email_login: boolean }) => request<ServerSettings>("PATCH", "/api/server", changes),
  updateSettings: (settings: Partial<AccountSettings>) =>
    request<AccountSettings>("PATCH", "/api/session/settings", settings),

  skills: () => request<Skill[]>("GET", "/api/skills"),
  setSkill: (id: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>("PATCH", `/api/skills/${encodeURIComponent(id)}`, { enabled }),
  alarms: () => request<AlarmsPage>("GET", "/api/alarms"),
  updateAlarm: (id: string, changes: { enabled?: boolean; device_id?: string }) =>
    request<Alarm>("PATCH", `/api/alarms/${encodeURIComponent(id)}`, changes),
  removeAlarm: (id: string) => request<void>("DELETE", `/api/alarms/${encodeURIComponent(id)}`),
  stopAlarm: (id: string) =>
    request<{ speakers: string[]; online: number }>("POST", `/api/alarms/${encodeURIComponent(id)}/stop`),
  devices: () => request<Device[]>("GET", "/api/devices"),
  addDevice: (id: string, name: string) => request<Device>("POST", "/api/devices", { id, name }),
  updateDevice: (id: string, changes: { name?: string; owner?: string | null }) =>
    request<void>("PATCH", `/api/devices/${encodeURIComponent(id)}`, changes),
  removeDevice: (id: string) => request<void>("DELETE", `/api/devices/${encodeURIComponent(id)}`),

  connections: () => request<Connection[]>("GET", "/api/connections"),
  /** An empty key or webhook secret keeps the one already stored and only updates the settings. */
  connectOpenai: (api_key: string, settings: OpenAiSettings, webhook_secret = "") =>
    request<Connection>("PUT", "/api/connections/openai", {
      api_key: api_key || undefined,
      webhook_secret: webhook_secret || undefined,
      settings,
    }),
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
  repairNumber: () => request<PhoneNumber>("POST", "/api/twilio/numbers/repair"),
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

  callTool: (name: string, args: Record<string, unknown>, conversationId: string | null, voice?: VoiceClient) =>
    request<{ output: unknown }>("POST", "/api/tools/call", {
      name,
      arguments: args,
      conversation_id: conversationId ?? undefined,
      client: voice ? { voice } : undefined,
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
  updateContact: (id: string, changes: ContactChanges) =>
    request<void>("PATCH", `/api/contacts/${encodeURIComponent(id)}`, changes),
  removeContact: (id: string) => request<void>("DELETE", `/api/contacts/${encodeURIComponent(id)}`),
  placeCall: (contact_id: string, message?: string) =>
    request<Placed>("POST", "/api/twilio/calls", { contact_id, message }),
  sendMessage: (contact_id: string, body: string, channel: Channel) =>
    request<Placed>("POST", "/api/twilio/messages", { contact_id, body, channel }),
  voiceToken: () => request<{ token: string; identity: string; ttl: number }>("GET", "/api/twilio/voice-token"),
  recentCalls: () => request<RecentCall[]>("GET", "/api/twilio/calls"),
  endCall: () => request<{ conference: string }>("POST", "/api/twilio/calls/end"),
  callReport: (conference: string) =>
    request<CallReport>("GET", `/api/twilio/conferences/${encodeURIComponent(conference)}/report`),
  hostAnswered: (conference: string) =>
    request<{ ok: boolean }>("POST", `/api/twilio/conferences/${encodeURIComponent(conference)}/answered`),
  addToCall: (ref: { contact_id?: string; to?: string }) =>
    request<Placed>("POST", "/api/twilio/conferences/participants", ref),

  users: () => request<User[]>("GET", "/api/users"),
  setRole: (username: string, role: Role) =>
    request<void>("PATCH", `/api/users/${encodeURIComponent(username)}`, { role }),
  removeUser: (username: string) => request<void>("DELETE", `/api/users/${encodeURIComponent(username)}`),
};
