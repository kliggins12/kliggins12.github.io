CREATE TABLE IF NOT EXISTS draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_filename TEXT NOT NULL,
  game TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT '',
  draw_date TEXT NOT NULL,
  numbers_json TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE(source_filename, draw_date)
);

CREATE INDEX IF NOT EXISTS idx_draws_game_session_date
  ON draws(game, session, draw_date);

CREATE INDEX IF NOT EXISTS idx_draws_source
  ON draws(source_filename);
