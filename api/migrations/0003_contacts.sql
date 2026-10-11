-- Twilio joins the providers; SQLite cannot widen a CHECK in place, so the table is rebuilt.
CREATE TABLE connections_v2 (
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'lightwave', 'twilio')),
  secret TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, provider)
);
INSERT INTO connections_v2 SELECT username, provider, secret, settings, created_at, updated_at FROM connections;
DROP TABLE connections;
ALTER TABLE connections_v2 RENAME TO connections;

-- The user's phone book, one row per number: imported from the phone, a vCard file, or typed in.
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  favourite INTEGER NOT NULL DEFAULT 0,
  last_called_at INTEGER,
  last_messaged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (username, phone)
);
CREATE INDEX contacts_by_name ON contacts (username, search_name);
CREATE INDEX contacts_by_favourite ON contacts (username, favourite DESC, search_name);

-- Every text and WhatsApp message through the user's Twilio number, both directions.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  sid TEXT,
  status TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX messages_by_contact ON messages (username, contact_id, at DESC);
CREATE INDEX messages_by_user ON messages (username, at DESC);

-- Every call leg: calls placed for the user, announcements, conference legs, and calls received.
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  kind TEXT NOT NULL CHECK (kind IN ('call', 'announcement', 'conference')),
  phone TEXT NOT NULL,
  conference TEXT,
  sid TEXT,
  status TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX calls_by_contact ON calls (username, contact_id, at DESC);
CREATE INDEX calls_by_user ON calls (username, at DESC);
CREATE UNIQUE INDEX calls_by_sid ON calls (sid) WHERE sid IS NOT NULL;
