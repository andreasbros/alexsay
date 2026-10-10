export type Role = "admin" | "user";
export type Provider = "openai" | "lightwave";

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
