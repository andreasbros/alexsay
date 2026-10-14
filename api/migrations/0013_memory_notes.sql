-- "Reminders" are alarms now (set_alarm, kind reminder); the memory category becomes "notes".
-- SQLite cannot change a CHECK constraint, so the table is rebuilt.
PRAGMA defer_foreign_keys = true;

CREATE TABLE memories_new (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('important', 'preferences', 'people', 'home', 'routines', 'notes', 'facts')),
  content TEXT NOT NULL,
  source_conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO memories_new (id, home_id, category, content, source_conversation_id, created_at, updated_at)
  SELECT id, home_id, CASE category WHEN 'reminders' THEN 'notes' ELSE category END, content, source_conversation_id,
    created_at, updated_at
  FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE INDEX memories_by_user ON memories (home_id, category, updated_at DESC);
