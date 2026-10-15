-- What the home is told about: an incoming text, a missed call, a message the assistant took on a call.
-- Shown under Messages, read out on the speakers, and marked read from either.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'message', 'note')),
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  phone TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref TEXT,
  at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_by_home ON notifications (home_id, at DESC);
