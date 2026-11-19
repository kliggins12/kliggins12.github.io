import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");

const statements = [
  `CREATE TABLE IF NOT EXISTS session_draws (
    game TEXT NOT NULL,
    session TEXT NOT NULL CHECK (session IN ('morning','day','evening','night')),
    draw_date TEXT NOT NULL,
    numbers TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (game, session, draw_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_draws_date
    ON session_draws(game, session, draw_date DESC)`,
  `CREATE TABLE IF NOT EXISTS board_events (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_board_events_replay
    ON board_events(game, session, draw_date, sequence)`,
  `CREATE TABLE IF NOT EXISTS board_checkpoints (
    game TEXT NOT NULL,
    session TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    state_blob TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    PRIMARY KEY(game, session, as_of_date)
  )`
];
const db = createClient({ url, authToken });

try {
  for (const statement of statements) await db.execute(statement);
  const result = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_draws','board_events','board_checkpoints') ORDER BY name"
  );
  const names = result.rows.map((row) => String(row.name));
  const expected = ["board_checkpoints", "board_events", "session_draws"];
  if (expected.some((name) => !names.includes(name))) {
    throw new Error("Turso schema verification failed: " + names.join(", "));
  }
  process.stdout.write("Turso schema ready: " + names.join(", ") + "\n");
} finally {
  await db.close();
}
