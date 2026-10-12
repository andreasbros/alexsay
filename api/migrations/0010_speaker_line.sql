-- A speaker's phone line: a pending bridge is created when a call opens on a speaker, and consumed
-- by the self-call that connects the conference to the speaker's media stream.
CREATE TABLE bridges (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  conference TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX bridges_by_user ON bridges (username, created_at);
