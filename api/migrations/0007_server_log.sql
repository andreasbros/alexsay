-- What the server did for a user, so the assistant can read it back when asked what happened.
CREATE TABLE server_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL
);
CREATE INDEX server_log_by_user ON server_log (username, id);

-- Off by default: the assistant may only read the log once the user ticked it in Settings.
ALTER TABLE users ADD COLUMN ai_log_access INTEGER NOT NULL DEFAULT 0;
