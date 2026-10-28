CREATE TABLE IF NOT EXISTS browser_events (
  event_id   TEXT PRIMARY KEY,
  em         TEXT,
  offer_id   TEXT,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_em ON browser_events (em, created_at);

CREATE TABLE IF NOT EXISTS sent (
  key        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS debug (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT,
  body       TEXT,
  created_at INTEGER NOT NULL
);
