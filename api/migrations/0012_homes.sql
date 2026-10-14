-- Homes: everything a person had now belongs to their home. A home's id is its creator's username,
-- so the data tables keep their keys and foreign keys; only the column is renamed.
CREATE TABLE homes (
  id TEXT PRIMARY KEY REFERENCES users (username) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Home',
  locale TEXT NOT NULL DEFAULT 'en-GB',
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  ai_log_access INTEGER NOT NULL DEFAULT 0,
  ai_call_test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO homes (id, locale, timezone, ai_log_access, ai_call_test, created_at)
  SELECT username, locale, timezone, ai_log_access, ai_call_test, created_at FROM users;

ALTER TABLE users DROP COLUMN locale;
ALTER TABLE users DROP COLUMN timezone;
ALTER TABLE users DROP COLUMN ai_log_access;
ALTER TABLE users DROP COLUMN ai_call_test;

-- The home a person is in; NULL is their own home, where they are always an admin.
ALTER TABLE users ADD COLUMN home_id TEXT REFERENCES homes (id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN home_role TEXT NOT NULL DEFAULT 'admin' CHECK (home_role IN ('admin', 'user'));
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX users_by_email ON users (email) WHERE email IS NOT NULL;
CREATE INDEX users_by_home ON users (home_id);

ALTER TABLE devices RENAME COLUMN owner TO home_id;
ALTER TABLE connections RENAME COLUMN username TO home_id;
ALTER TABLE conversations RENAME COLUMN username TO home_id;
ALTER TABLE memories RENAME COLUMN username TO home_id;
ALTER TABLE contacts RENAME COLUMN username TO home_id;
ALTER TABLE messages RENAME COLUMN username TO home_id;
ALTER TABLE calls RENAME COLUMN username TO home_id;
ALTER TABLE call_reports RENAME COLUMN username TO home_id;
ALTER TABLE server_log RENAME COLUMN username TO home_id;
ALTER TABLE bridges RENAME COLUMN username TO home_id;
ALTER TABLE jobs RENAME COLUMN username TO home_id;
ALTER TABLE user_skills RENAME COLUMN username TO home_id;
ALTER TABLE alarms RENAME COLUMN username TO home_id;
ALTER TABLE alarm_events RENAME COLUMN username TO home_id;

-- Server-wide switches set by server admins (email login).
CREATE TABLE server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One live code per address and purpose: 'login', or 'verify' (adding an email to an account).
-- Code and link token are stored only as HMACs under a key derived from SECRETS_KEY.
CREATE TABLE email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'verify')),
  username TEXT REFERENCES users (username) ON DELETE CASCADE,
  code_mac TEXT NOT NULL,
  token_mac TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  token_mac TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT
);
CREATE UNIQUE INDEX invites_one_pending ON invites (home_id, email) WHERE status = 'pending';
CREATE INDEX invites_by_home ON invites (home_id, created_at DESC);
