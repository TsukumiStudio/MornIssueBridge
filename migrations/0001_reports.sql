CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  project TEXT NOT NULL,
  reporter_id TEXT NOT NULL DEFAULT '',
  reporter_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received', 'created', 'failed')),
  issue_url TEXT,
  issue_number INTEGER,
  error TEXT
);
CREATE INDEX reports_received ON reports(received_at DESC, id DESC);
CREATE INDEX reports_project ON reports(project, received_at DESC);
