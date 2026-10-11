export type Role = "admin" | "user";
export type Provider = "openai" | "lightwave" | "twilio";

export interface User {
  username: string;
  role: Role;
}

export interface UserRow extends User {
  password_hash: string;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  owner: string | null;
  created_at: number;
  claimed_at: number | null;
  last_seen_at: number | null;
  firmware: string | null;
  last_meta: string | null;
}

export interface ConnectionRow {
  username: string;
  provider: Provider;
  secret: string;
  settings: string;
  created_at: number;
  updated_at: number;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { user: User };
}

export type ConversationSource = "app" | "device";
export type TurnRole = "user" | "assistant" | "tool";
export const MEMORY_CATEGORIES = [
  "important",
  "preferences",
  "people",
  "home",
  "routines",
  "reminders",
  "facts",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface ConversationRow {
  id: string;
  username: string;
  source: ConversationSource;
  device_id: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  turn_count: number;
}

export interface TurnRow {
  id: number;
  conversation_id: string;
  at: number;
  role: TurnRole;
  text: string;
}

export interface MemoryRow {
  id: string;
  username: string;
  category: MemoryCategory;
  content: string;
  source_conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactRow {
  id: string;
  username: string;
  name: string;
  search_name: string;
  phone: string;
  label: string;
  note: string;
  favourite: number;
  last_called_at: number | null;
  last_messaged_at: number | null;
  created_at: number;
  updated_at: number;
}

export type Channel = "sms" | "whatsapp";
export type Direction = "out" | "in";
export type CallKind = "call" | "announcement" | "conference";

export interface MessageRow {
  id: string;
  username: string;
  contact_id: string | null;
  channel: Channel;
  direction: Direction;
  phone: string;
  body: string;
  sid: string | null;
  status: string;
  at: number;
}

export interface CallRow {
  id: string;
  username: string;
  contact_id: string | null;
  direction: Direction;
  kind: CallKind;
  phone: string;
  conference: string | null;
  sid: string | null;
  status: string;
  at: number;
}
