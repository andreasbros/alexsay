-- Spotify joins the providers; SQLite cannot widen a CHECK in place, so the table is rebuilt.
CREATE TABLE connections_v3 (
  home_id TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'lightwave', 'twilio', 'spotify')),
  secret TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, provider)
);
INSERT INTO connections_v3 SELECT home_id, provider, secret, settings, created_at, updated_at FROM connections;
DROP TABLE connections;
ALTER TABLE connections_v3 RENAME TO connections;
