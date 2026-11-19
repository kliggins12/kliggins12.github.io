-- Turso: compact history for the 12 sessioned sources.
-- Store each official draw once. Numbers remain in source order as compact text.
CREATE TABLE IF NOT EXISTS session_draws (
  game TEXT NOT NULL,
  session TEXT NOT NULL CHECK (session IN ('morning','day','evening','night')),
  draw_date TEXT NOT NULL,
  numbers TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (game, session, draw_date)
);

CREATE INDEX IF NOT EXISTS idx_session_draws_date
  ON session_draws(game, session, draw_date DESC);

-- Compact event log: only board changes, never a full board copy per draw.
CREATE TABLE IF NOT EXISTS board_events (
  event_id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  session TEXT NOT NULL,
  draw_date TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  op TEXT NOT NULL,
  marking_id TEXT,
  from_row INTEGER,
  from_col INTEGER,
  to_row INTEGER,
  to_col INTEGER,
  value INTEGER,
  rule_version INTEGER NOT NULL,
  UNIQUE(game, session, draw_date, sequence)
);

CREATE INDEX IF NOT EXISTS idx_board_events_replay
  ON board_events(game, session, draw_date, sequence);

-- Occasional checkpoints only; replay intervening board_events.
CREATE TABLE IF NOT EXISTS board_checkpoints (
  game TEXT NOT NULL,
  session TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  state_blob TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  PRIMARY KEY(game, session, as_of_date)
);
