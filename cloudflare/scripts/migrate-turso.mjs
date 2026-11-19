import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");

const sql = await readFile(new URL("../turso/0001_session_history.sql", import.meta.url), "utf8");
const statements = sql
  .split(";")
  .map((s) => s.replace(/^\\s*--.*$/gm, "").trim())
  .filter((s) => s.length > 0);
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
