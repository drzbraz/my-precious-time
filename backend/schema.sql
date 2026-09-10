CREATE TABLE IF NOT EXISTS presence (
  meeting_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rate_per_minute REAL NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_meeting ON presence (meeting_id, last_seen_at);
