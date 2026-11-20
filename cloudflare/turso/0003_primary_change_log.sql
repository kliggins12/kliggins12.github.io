-- Incremental change stream for the Cloudflare D1 read-only standby.
-- Apply before the full-history import; that import's final change_id is stored
-- as the D1 baseline cursor after exact source verification.

CREATE TABLE IF NOT EXISTS primary_change_log (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  key_a TEXT NOT NULL,
  key_b TEXT NOT NULL DEFAULT '',
  key_c TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_primary_change_log_table
  ON primary_change_log(table_name, change_id);

CREATE TRIGGER IF NOT EXISTS trg_lottery_draws_ai
AFTER INSERT ON lottery_draws
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,changed_at)
  VALUES('lottery_draws','upsert',NEW.source_filename,NEW.draw_date,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_lottery_draws_au
AFTER UPDATE ON lottery_draws
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,changed_at)
  VALUES('lottery_draws','upsert',NEW.source_filename,NEW.draw_date,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_lottery_draws_ad
AFTER DELETE ON lottery_draws
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,changed_at)
  VALUES('lottery_draws','delete',OLD.source_filename,OLD.draw_date,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_source_files_ai
AFTER INSERT ON source_files
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('source_files','upsert',NEW.filename,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_source_files_au
AFTER UPDATE ON source_files
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('source_files','upsert',NEW.filename,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_source_files_ad
AFTER DELETE ON source_files
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('source_files','delete',OLD.filename,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_ingestion_runs_ai
AFTER INSERT ON ingestion_runs
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('ingestion_runs','upsert',CAST(NEW.id AS TEXT),STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_ingestion_runs_au
AFTER UPDATE ON ingestion_runs
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('ingestion_runs','upsert',CAST(NEW.id AS TEXT),STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_ingestion_runs_ad
AFTER DELETE ON ingestion_runs
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('ingestion_runs','delete',CAST(OLD.id AS TEXT),STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_analysis_artifacts_ai
AFTER INSERT ON analysis_artifacts
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,changed_at)
  VALUES('analysis_artifacts','upsert',NEW.artifact_key,NEW.generated_at,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_analysis_artifacts_au
AFTER UPDATE ON analysis_artifacts
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,changed_at)
  VALUES('analysis_artifacts','upsert',NEW.artifact_key,NEW.generated_at,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_analysis_artifacts_ad
AFTER DELETE ON analysis_artifacts
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,changed_at)
  VALUES('analysis_artifacts','delete',OLD.artifact_key,OLD.generated_at,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_board_events_ai
AFTER INSERT ON board_events
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('board_events','upsert',NEW.event_id,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_board_events_au
AFTER UPDATE ON board_events
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('board_events','upsert',NEW.event_id,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_board_events_ad
AFTER DELETE ON board_events
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,changed_at)
  VALUES('board_events','delete',OLD.event_id,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_board_checkpoints_ai
AFTER INSERT ON board_checkpoints
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,key_c,changed_at)
  VALUES('board_checkpoints','upsert',NEW.game,NEW.session,NEW.as_of_date,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_board_checkpoints_au
AFTER UPDATE ON board_checkpoints
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,key_c,changed_at)
  VALUES('board_checkpoints','upsert',NEW.game,NEW.session,NEW.as_of_date,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_board_checkpoints_ad
AFTER DELETE ON board_checkpoints
BEGIN
  INSERT INTO primary_change_log(table_name,operation,key_a,key_b,key_c,changed_at)
  VALUES('board_checkpoints','delete',OLD.game,OLD.session,OLD.as_of_date,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
END;
