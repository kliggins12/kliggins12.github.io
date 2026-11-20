import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");

const db = createClient({ url, authToken });
const migrationFiles = [
  new URL("../turso/0001_session_history.sql", import.meta.url),
  new URL("../turso/0002_primary_history.sql", import.meta.url)
];
const expected = [
  "analysis_artifacts",
  "board_checkpoints",
  "board_events",
  "ingestion_runs",
  "lottery_draws",
  "migration_runs",
  "migration_source_progress",
  "session_draws",
  "source_files"
];

try {
  for (const migrationFile of migrationFiles) {
    const sql = await readFile(migrationFile, "utf8");
    await db.executeMultiple(sql);
  }

  const result = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const names = result.rows.map((row) => String(row.name));
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new Error("Turso schema verification failed. Missing: " + missing.join(", "));
  }
  process.stdout.write("Turso schema ready: " + names.join(", ") + "\n");
} finally {
  db.close();
}
