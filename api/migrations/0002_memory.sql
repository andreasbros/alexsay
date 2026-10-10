-- Every conversation a user has with the assistant, from the app or a speaker.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('app', 'device')),
  device_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX conversations_by_user_time ON conversations (username, started_at DESC);

CREATE TABLE conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  text TEXT NOT NULL
);
CREATE INDEX turns_by_conversation ON conversation_turns (conversation_id, at, id);

-- What the assistant knows about a user across conversations, one record per fact.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('important', 'preferences', 'people', 'home', 'routines', 'reminders', 'facts')),
  content TEXT NOT NULL,
  source_conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memories_by_user ON memories (username, category, updated_at DESC);
