CREATE TABLE IF NOT EXISTS source_files (
  filename TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  last_modified TEXT,
  etag TEXT,
  r2_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
  files_expected INTEGER NOT NULL,
  files_updated INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_started
  ON ingestion_runs(started_at DESC);
