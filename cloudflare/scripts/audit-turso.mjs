import { createClient } from "@libsql/client";
import { mkdir, writeFile } from "node:fs/promises";

const outputDirectory = "audit-output";
const databaseUrl = process.env.TURSO_READONLY_DATABASE_URL;
const authToken = process.env.TURSO_READONLY_AUTH_TOKEN;
const expectedGames = ["Pick 3", "Daily 4", "All or Nothing"];
const expectedSessions = ["morning", "day", "evening", "night"];
const expectedStreams = expectedGames.flatMap((game) =>
  expectedSessions.map((session) => ({ game, session }))
);
const expectedTables = ["session_draws", "board_events", "board_checkpoints"];

const report = {
  generated_at: new Date().toISOString(),
  database_host: null,
  access_mode: "read-only token supplied by GitHub Secrets",
  status: "FAIL",
  tables: [],
  missing_tables: [],
  session_draws: {
    total_rows: 0,
    first_date: null,
    latest_date: null,
    distinct_source_files: 0,
    observed_streams: [],
    missing_streams: []
  },
  board_events: { total_rows: 0, first_date: null, latest_date: null },
  board_checkpoints: { total_rows: 0, first_date: null, latest_date: null },
  warnings: [],
  errors: []
};

function normalizeRows(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : value
      ])
    )
  );
}

function asNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toMarkdown(data) {
  const lines = [
    "# Turso session-history audit",
    "",
    "- Generated: " + data.generated_at,
    "- Database host: " + (data.database_host ?? "not available"),
    "- Access mode: " + data.access_mode,
    "- Status: **" + data.status + "**",
    "",
    "## Schema",
    "",
    data.tables.length
      ? data.tables.map((table) => "- " + table.name).join("\n")
      : "- No tables could be read",
    "",
    "## Session draw history",
    "",
    "- Total rows: " + data.session_draws.total_rows,
    "- Earliest draw: " + (data.session_draws.first_date ?? "not available"),
    "- Latest draw: " + (data.session_draws.latest_date ?? "not available"),
    "- Distinct source files: " + data.session_draws.distinct_source_files,
    "- Observed streams: " + data.session_draws.observed_streams.length + " / 12",
    "- Missing streams: " + (
      data.session_draws.missing_streams.length
        ? data.session_draws.missing_streams.map((item) => item.game + " / " + item.session).join(", ")
        : "none"
    ),
    "",
    "## Session-by-session counts",
    "",
    "| Game | Session | Rows | First date | Latest date |",
    "|---|---|---:|---|---|",
    ...data.session_draws.observed_streams.map((stream) =>
      "| " + stream.game + " | " + stream.session + " | " + stream.row_count +
      " | " + (stream.first_date ?? "—") + " | " + (stream.latest_date ?? "—") + " |"
    ),
    "",
    "## Replay tables",
    "",
    "- board_events: " + data.board_events.total_rows + " rows" +
      (data.board_events.first_date ? " (" + data.board_events.first_date + " to " + data.board_events.latest_date + ")" : ""),
    "- board_checkpoints: " + data.board_checkpoints.total_rows + " rows" +
      (data.board_checkpoints.first_date ? " (" + data.board_checkpoints.first_date + " to " + data.board_checkpoints.latest_date + ")" : ""),
    "",
    "## Warnings",
    "",
    ...(data.warnings.length ? data.warnings.map((item) => "- " + item) : ["- None"]),
    "",
    "## Errors",
    "",
    ...(data.errors.length ? data.errors.map((item) => "- " + item) : ["- None"]),
    "",
    "This report contains schema and aggregate counts only; it does not export lottery number values or database credentials.",
    ""
  ];
  return lines.join("\n");
}

await mkdir(outputDirectory, { recursive: true });

let db;
try {
  if (!databaseUrl || !authToken) {
    throw new Error(
      "Missing TURSO_READONLY_DATABASE_URL or TURSO_READONLY_AUTH_TOKEN GitHub Secret."
    );
  }

  try {
    report.database_host = new URL(databaseUrl).host;
  } catch {
    throw new Error("TURSO_READONLY_DATABASE_URL is not a valid URL.");
  }

  db = createClient({ url: databaseUrl, authToken });

  const tableResult = await db.execute(
    "SELECT name, sql FROM sqlite_master " +
    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  report.tables = normalizeRows(tableResult.rows);
  const tableNames = new Set(report.tables.map((table) => table.name));
  report.missing_tables = expectedTables.filter((name) => !tableNames.has(name));

  if (report.missing_tables.length) {
    report.errors.push("Required tables are missing: " + report.missing_tables.join(", "));
  }

  if (tableNames.has("session_draws")) {
    const totalsResult = await db.execute(
      "SELECT COUNT(*) AS total_rows, MIN(draw_date) AS first_date, " +
      "MAX(draw_date) AS latest_date, COUNT(DISTINCT source_file) AS distinct_source_files " +
      "FROM session_draws"
    );
    const totals = normalizeRows(totalsResult.rows)[0] ?? {};
    report.session_draws.total_rows = asNumber(totals.total_rows);
    report.session_draws.first_date = totals.first_date ?? null;
    report.session_draws.latest_date = totals.latest_date ?? null;
    report.session_draws.distinct_source_files = asNumber(totals.distinct_source_files);

    const streamsResult = await db.execute(
      "SELECT game, session, COUNT(*) AS row_count, MIN(draw_date) AS first_date, " +
      "MAX(draw_date) AS latest_date FROM session_draws " +
      "GROUP BY game, session ORDER BY game, session"
    );
    report.session_draws.observed_streams = normalizeRows(streamsResult.rows).map((row) => ({
      game: row.game,
      session: row.session,
      row_count: asNumber(row.row_count),
      first_date: row.first_date ?? null,
      latest_date: row.latest_date ?? null
    }));

    const observed = new Set(
      report.session_draws.observed_streams.map((row) => row.game + "|" + row.session)
    );
    report.session_draws.missing_streams = expectedStreams.filter(
      (stream) => !observed.has(stream.game + "|" + stream.session)
    );

    if (report.session_draws.total_rows === 0) {
      report.errors.push("session_draws exists but contains no rows.");
    }
    if (report.session_draws.missing_streams.length) {
      report.errors.push(
        "Expected 12 game/session streams; missing " +
        report.session_draws.missing_streams.length + "."
      );
    }
  }

  if (tableNames.has("board_events")) {
    const result = await db.execute(
      "SELECT COUNT(*) AS total_rows, MIN(draw_date) AS first_date, " +
      "MAX(draw_date) AS latest_date FROM board_events"
    );
    const row = normalizeRows(result.rows)[0] ?? {};
    report.board_events = {
      total_rows: asNumber(row.total_rows),
      first_date: row.first_date ?? null,
      latest_date: row.latest_date ?? null
    };
    if (report.board_events.total_rows === 0) {
      report.warnings.push("board_events is present but has no replay events yet.");
    }
  }

  if (tableNames.has("board_checkpoints")) {
    const result = await db.execute(
      "SELECT COUNT(*) AS total_rows, MIN(as_of_date) AS first_date, " +
      "MAX(as_of_date) AS latest_date FROM board_checkpoints"
    );
    const row = normalizeRows(result.rows)[0] ?? {};
    report.board_checkpoints = {
      total_rows: asNumber(row.total_rows),
      first_date: row.first_date ?? null,
      latest_date: row.latest_date ?? null
    };
    if (report.board_checkpoints.total_rows === 0) {
      report.warnings.push("board_checkpoints is present but no snapshots have been created yet.");
    }
  }

  report.status = report.errors.length ? "FAIL" : "PASS";
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error));
  report.status = "FAIL";
} finally {
  if (db) {
    try {
      await db.close();
    } catch (error) {
      report.warnings.push(
        "Database client close reported: " +
        (error instanceof Error ? error.message : String(error))
      );
    }
  }
  await writeFile(
    outputDirectory + "/turso-audit.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  );
  await writeFile(
    outputDirectory + "/turso-audit.md",
    toMarkdown(report),
    { mode: 0o600 }
  );
}

console.log("Turso audit status: " + report.status);
console.log("Database host: " + (report.database_host ?? "not available"));
console.log("Session draw rows: " + report.session_draws.total_rows);
console.log("Observed streams: " + report.session_draws.observed_streams.length + " / 12");
console.log("Missing required tables: " + report.missing_tables.length);
if (report.errors.length) {
  console.error(report.errors.join("\n"));
}
if (report.status !== "PASS") {
  process.exitCode = 1;
}
