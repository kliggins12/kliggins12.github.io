-- Immutable, chronological board replay storage.
-- One run is scoped to a game/session and an explicit rule version.
-- Every assumption is frozen before its target draw and is never overwritten.

CREATE TABLE IF NOT EXISTS board_replay_runs (
  run_id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  session TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  first_draw_date TEXT,
  last_draw_date TEXT,
  draw_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','complete','failed')),
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_replay_runs_game_session
  ON board_replay_runs(game, session, created_at);

CREATE TABLE IF NOT EXISTS board_states (
  state_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  draw_key TEXT NOT NULL,
  draw_date TEXT NOT NULL,
  board_revision INTEGER NOT NULL,
  predecessor_state_id TEXT,
  markings_json TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(run_id, draw_key),
  FOREIGN KEY(run_id) REFERENCES board_replay_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_board_states_run_date
  ON board_states(run_id, draw_date);

CREATE TABLE IF NOT EXISTS board_assumptions (
  assumption_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  target_draw_key TEXT NOT NULL,
  target_draw_date TEXT NOT NULL,
  source_cutoff_draw_key TEXT,
  source_cutoff_date TEXT,
  predecessor_assumption_id TEXT,
  source_board_revision INTEGER NOT NULL,
  source_markings_json TEXT NOT NULL,
  projected_markings_json TEXT NOT NULL,
  proposed_changes_json TEXT NOT NULL DEFAULT '[]',
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, target_draw_key),
  FOREIGN KEY(run_id) REFERENCES board_replay_runs(run_id),
  FOREIGN KEY(predecessor_assumption_id) REFERENCES board_assumptions(assumption_id)
);

CREATE INDEX IF NOT EXISTS idx_board_assumptions_run_date
  ON board_assumptions(run_id, target_draw_date);

CREATE TABLE IF NOT EXISTS board_assumption_evaluations (
  assumption_id TEXT PRIMARY KEY,
  actual_draw_key TEXT NOT NULL,
  actual_draw_date TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  evaluation_json TEXT NOT NULL,
  FOREIGN KEY(assumption_id) REFERENCES board_assumptions(assumption_id)
);

CREATE INDEX IF NOT EXISTS idx_board_assumption_evaluations_actual_date
  ON board_assumption_evaluations(actual_draw_date);
