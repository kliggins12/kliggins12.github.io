import { createClient } from "@libsql/client";

const worker = process.env.WORKER_URL;
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!worker || !url || !authToken) {
  throw new Error("Missing WORKER_URL, TURSO_DATABASE_URL, or TURSO_AUTH_TOKEN");
}

const sources = [
  ["aon_morning.csv", "All or Nothing", "morning"],
  ["aon_day.csv", "All or Nothing", "day"],
  ["aon_evening.csv", "All or Nothing", "evening"],
  ["aon_night.csv", "All or Nothing", "night"],
  ["pick3morning.csv", "Pick 3", "morning"],
  ["pick3day.csv", "Pick 3", "day"],
  ["pick3evening.csv", "Pick 3", "evening"],
  ["pick3night.csv", "Pick 3", "night"],
  ["daily4morning.csv", "Daily 4", "morning"],
  ["daily4day.csv", "Daily 4", "day"],
  ["daily4evening.csv", "Daily 4", "evening"],
  ["daily4night.csv", "Daily 4", "night"]
];

const db = createClient({ url, authToken });
const insert = `INSERT INTO session_draws
  (game, session, draw_date, numbers, source_file, source_hash, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(game, session, draw_date) DO UPDATE SET
    numbers=excluded.numbers,
    source_file=excluded.source_file,
    source_hash=excluded.source_hash,
    imported_at=excluded.imported_at`;

try {
  let total = 0;
  for (const [file, game, session] of sources) {
    let before = "";
    let sourceTotal = 0;
    for (;;) {
      const params = new URLSearchParams({ game, session, limit: "500" });
      if (before) params.set("before", before);
      const response = await fetch(`${worker}/api/draws?${params}`);
      if (!response.ok) throw new Error(`D1 read failed for ${file}: HTTP ${response.status}`);
      const payload = await response.json();
      const rows = payload.draws ?? [];
      if (!rows.length) break;

      const statements = rows.map((row) => ({
        sql: insert,
        args: [
          row.game,
          row.session,
          row.draw_date,
          row.numbers_json,
          row.source_filename,
          row.source_sha256,
          row.imported_at
        ]
      }));
      await db.batch(statements, "write");
      sourceTotal += rows.length;
      total += rows.length;
      const dates = rows.map((row) => row.draw_date).sort();
      const oldest = dates[0];
      if (rows.length < 500) break;
      if (before && oldest >= before) throw new Error(`Pagination did not advance for ${file}`);
      before = oldest;
    }
    process.stdout.write(`${file}: ${sourceTotal} rows copied\\n`);
  }

  const result = await db.execute(
    "SELECT game, session, COUNT(*) AS rows, MIN(draw_date) AS first_date, MAX(draw_date) AS latest_date FROM session_draws GROUP BY game, session ORDER BY game, CASE session WHEN 'morning' THEN 1 WHEN 'day' THEN 2 WHEN 'evening' THEN 3 WHEN 'night' THEN 4 END"
  );
  process.stdout.write(`Total rows copied this run: ${total}\\n`);
  process.stdout.write(JSON.stringify(result.rows, null, 2) + "\\n");
  const count = await db.execute("SELECT COUNT(*) AS total FROM session_draws");
  process.stdout.write(`Turso session_draws total: ${count.rows[0].total}\\n`);
} finally {
  await db.close();
}
