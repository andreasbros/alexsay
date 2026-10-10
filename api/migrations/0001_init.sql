CREATE TABLE users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_sha256 TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_failures (
  username TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_failures_by_user ON login_failures (username, at);

-- A speaker. It appears either when its owner adds its UUID or when it first calls home.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  owner TEXT REFERENCES users (username) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_seen_at INTEGER,
  firmware TEXT,
  last_meta TEXT
);
CREATE INDEX devices_by_owner ON devices (owner);

-- One row per user and provider; secret is AES-GCM encrypted JSON, settings is plain JSON.
CREATE TABLE connections (
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'lightwave')),
  secret TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, provider)
);
