CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_expiresAt ON reports(expiresAt);
