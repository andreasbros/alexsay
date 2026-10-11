-- What was said on a call (as the assistant's leg heard it) and how the call ended, so the page's
-- assistant gets a report the moment the line drops.
CREATE TABLE call_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conference TEXT NOT NULL,
  at INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('assistant', 'line')),
  text TEXT NOT NULL
);
CREATE INDEX call_turns_by_conference ON call_turns (conference, id);

CREATE TABLE call_reports (
  conference TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  ended_at INTEGER NOT NULL,
  ended_by TEXT NOT NULL
);

-- When each leg left the conference, to tell who hung up first.
ALTER TABLE calls ADD COLUMN left_at INTEGER;

-- Off by default: test calls (a scripted AI answering over SIP) exist only once the user ticked it in Settings.
ALTER TABLE users ADD COLUMN ai_call_test INTEGER NOT NULL DEFAULT 0;
