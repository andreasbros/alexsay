-- The scheduler's jobs: any skill or component stores one and a per-user Durable Object runs it at
-- next_at (an occurrence plus delay_ms) through the router, then moves it to its next occurrence.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  rule TEXT NOT NULL,
  delay_ms INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER
);
CREATE INDEX jobs_due ON jobs (username, enabled, next_at);

-- Skills the user switched off; a skill without a row is on.
CREATE TABLE user_skills (
  username TEXT NOT NULL,
  skill TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (username, skill)
);

-- Alarms, timers and reminders; rings on device_id, whose own clock fires it.
CREATE TABLE alarms (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  device_id TEXT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  rule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER,
  snoozed_until INTEGER,
  job_id TEXT NOT NULL,
  created_via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX alarms_by_user ON alarms (username, next_at);
CREATE INDEX alarms_by_device ON alarms (device_id);

-- What happened at each occurrence: rang, stopped, snoozed, missed.
CREATE TABLE alarm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_id TEXT NOT NULL,
  username TEXT NOT NULL,
  device_id TEXT,
  occurrence INTEGER NOT NULL,
  event TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX alarm_events_once ON alarm_events (alarm_id, occurrence, event);
CREATE INDEX alarm_events_by_user ON alarm_events (username, at);
