import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const DATABASE_URL = process.env.TURSO_DATABASE_URL;
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const SAMPLE_SIZE = Number(process.env.TURSO_PREVIEW_SAMPLE_SIZE || 100);
const RETENTION_HOURS = 24;
const TX_BASE = "https://www.texaslottery.com/export/sites/lottery/Games";

const SOURCES = [
  ...["morning", "day", "evening", "night"].map((session) => ({
    filename: `aon_${session}.csv`,
    url: `${TX_BASE}/All_or_Nothing/Winning_Numbers/allornothing${session}.csv`,
    game: "All or Nothing", session, numberCount: 12, min: 1, max: 24
  })),
  ...["morning", "day", "evening", "night"].map((session) => ({
    filename: `pick3${session}.csv`,
    url: `${TX_BASE}/Pick_3/Winning_Numbers/pick3${session}.csv`,
    game: "Pick 3", session, numberCount: 3, min: 0, max: 9
  })),
  ...["morning", "day", "evening", "night"].map((session) => ({
    filename: `daily4${session}.csv`,
    url: `${TX_BASE}/Daily_4/Winning_Numbers/daily4${session}.csv`,
    game: "Daily 4", session, numberCount: 4, min: 0, max: 9
  }))
];

if (!DATABASE_URL || !AUTH_TOKEN) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN GitHub Actions secrets.");
}
if (!Number.isSafeInteger(SAMPLE_SIZE) || SAMPLE_SIZE < 1 || SAMPLE_SIZE > 100) {
  throw new Error("TURSO_PREVIEW_SAMPLE_SIZE must be an integer from 1 to 100.");
}

function parseCsvRows(input) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

function validDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 1900 ||
      month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseSource(text, source) {
  const rows = parseCsvRows(text);
  const draws = [];
  for (const row of rows.slice(1)) {
    const month = Number((row[1] || "").trim());
    const day = Number((row[2] || "").trim());
    const year = Number((row[3] || "").trim());
    const drawDate = validDate(year, month, day);
    if (!drawDate) continue;

    const rawNumbers = row.slice(4, 4 + source.numberCount);
    if (rawNumbers.length !== source.numberCount) continue;
    const numbers = rawNumbers.map((value) => Number(String(value).trim()));
    if (numbers.some((value) => !Number.isInteger(value) || value < source.min || value > source.max)) continue;
    if (source.game === "All or Nothing" && new Set(numbers).size !== source.numberCount) continue;
    draws.push({ draw_date: drawDate, numbers });
  }

  const unique = new Map();
  for (const draw of draws) unique.set(draw.draw_date, draw);
  return [...unique.values()].sort((a, b) => a.draw_date.localeCompare(b.draw_date));
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: { "user-agent": "BatchmateTempPreview/1.0 (read-only source preview)" },
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`${source.filename}: HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim() || /^\s*<(?:!doctype\s+html|html)/i.test(text)) {
    throw new Error(`${source.filename}: empty response or HTML instead of CSV`);
  }
  if (!text.includes(",") || !text.includes("\n")) {
    throw new Error(`${source.filename}: response does not look like CSV`);
  }
  const draws = parseSource(text, source);
  if (!draws.length) throw new Error(`${source.filename}: no valid drawing rows parsed; nothing has been written to Turso`);
  const sourceHash = createHash("sha256").update(text, "utf8").digest("hex");
  const sample = draws.slice(-SAMPLE_SIZE);
  return { source, sourceHash, totalParsed: draws.length, sample };
}

function summarize(item) {
  const { source, sample } = item;
  const frequency = new Map();
  const positions = Array.from({ length: source.numberCount }, () => new Map());
  const sums = new Map();
  const combos = new Map();
  let sumTotal = 0;

  for (const draw of sample) {
    const sum = draw.numbers.reduce((total, value) => total + value, 0);
    sumTotal += sum;
    sums.set(sum, (sums.get(sum) || 0) + 1);
    const key = draw.numbers.join("-");
    combos.set(key, (combos.get(key) || 0) + 1);
    draw.numbers.forEach((value, index) => {
      frequency.set(value, (frequency.get(value) || 0) + 1);
      positions[index].set(value, (positions[index].get(value) || 0) + 1);
    });
  }

  const sortedFrequency = (map) => [...map.entries()]
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => b.count - a.count || a.value - b.value);

  return {
    game: source.game,
    session: source.session,
    source_file: source.filename,
    source_sha256: item.sourceHash,
    total_valid_rows_in_source: item.totalParsed,
    sample_rows: sample.length,
    first_sample_date: sample[0].draw_date,
    latest_sample_date: sample[sample.length - 1].draw_date,
    latest_drawing: {
      date: sample[sample.length - 1].draw_date,
      numbers: sample[sample.length - 1].numbers
    },
    mean_draw_sum: Number((sumTotal / sample.length).toFixed(2)),
    top_numbers: sortedFrequency(frequency).slice(0, 12),
    position_frequencies: positions.map((map, index) => ({
      position: index + 1,
      top: sortedFrequency(map).slice(0, 10)
    })),
    most_common_sums: sortedFrequency(sums).slice(0, 8),
    repeated_combinations: [...combos.entries()]
      .filter(([, count]) => count > 1)
      .map(([combination, count]) => ({ combination, count }))
      .sort((a, b) => b.count - a.count || a.combination.localeCompare(b.combination))
      .slice(0, 10)
  };
}

function toMarkdown(report) {
  const lines = [
    "# Batchmate temporary Turso preview",
    "",
    `- Run ID: ${report.run_id}`,
    `- Generated UTC: ${report.created_at}`,
    `- Expires UTC: ${report.expires_at}`,
    `- Sources checked: ${report.source_count}`,
    `- Draw rows loaded: ${report.draw_rows}`,
    `- Sample: latest ${report.sample_size_per_stream} valid rows per stream`,
    "",
    "## Stream results",
    "",
    "| Game | Session | Rows in source | Sample rows | First sample | Latest draw |",
    "|---|---|---:|---:|---|---|",
    ...report.streams.map((stream) =>
      `| ${stream.game} | ${stream.session} | ${stream.total_valid_rows_in_source} | ${stream.sample_rows} | ${stream.first_sample_date} | ${stream.latest_sample_date}: ${stream.latest_drawing.numbers.join(", ")} |`
    ),
    "",
    "## Analysis notes",
    ""
  ];

  for (const stream of report.streams) {
    lines.push(
      `### ${stream.game} — ${stream.session}`,
      "",
      `Latest draw: **${stream.latest_sample_date}** — ${stream.latest_drawing.numbers.join(", ")}`,
      "",
      `Mean draw sum in sample: **${stream.mean_draw_sum}**`,
      "",
      `Most frequent values: ${stream.top_numbers.map((item) => `${item.value} (${item.count})`).join(", ")}`,
      "",
      `Repeated exact combinations: ${stream.repeated_combinations.length ? stream.repeated_combinations.map((item) => `${item.combination} × ${item.count}`).join("; ") : "None in this sample"}`,
      ""
    );
  }

  lines.push(
    "---",
    "",
    "This is a descriptive sample of historical official drawings, not a prediction. Only temporary Turso preview tables were written. Canonical session_draws and board replay tables were not modified.",
    ""
  );
  return lines.join("\n");
}

function toCsv(report, loaded) {
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = ["game,session,draw_date,numbers,number_sum,source_file"];
  for (const stream of report.streams) {
    const item = loaded.find((entry) => entry.source.filename === stream.source_file);
    for (const draw of item.sample) {
      lines.push([
        stream.game, stream.session, draw.draw_date,
        draw.numbers.join(" "), draw.numbers.reduce((a, b) => a + b, 0),
        stream.source_file
      ].map(quote).join(","));
    }
  }
  return lines.join("\n") + "\n";
}

const createdAt = new Date();
const runId = `preview-${createdAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const expiresAt = new Date(createdAt.getTime() + RETENTION_HOURS * 60 * 60 * 1000);
const outputDirectory = "temp-preview-output";
const loaded = [];
let db;
let runInserted = false;

try {
  // Fetch and validate every source before the first Turso write.
  const fetched = await Promise.all(SOURCES.map(fetchSource));
  for (const item of fetched) loaded.push(item);
  const streams = fetched.map(summarize);
  const report = {
    run_id: runId,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    sample_size_per_stream: SAMPLE_SIZE,
    source_count: fetched.length,
    draw_rows: fetched.reduce((total, item) => total + item.sample.length, 0),
    streams
  };

  db = createClient({ url: DATABASE_URL, authToken: AUTH_TOKEN });

  const schema = [
    `CREATE TABLE IF NOT EXISTS temp_preview_runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      sample_size_per_stream INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      draw_rows INTEGER NOT NULL,
      status TEXT NOT NULL,
      report_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS temp_preview_draws (
      run_id TEXT NOT NULL,
      game TEXT NOT NULL,
      session TEXT NOT NULL,
      draw_date TEXT NOT NULL,
      numbers_json TEXT NOT NULL,
      number_sum INTEGER NOT NULL,
      sample_index INTEGER NOT NULL,
      source_file TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      PRIMARY KEY(run_id, game, session, draw_date)
    )`,
    `CREATE TABLE IF NOT EXISTS temp_preview_notes (
      run_id TEXT NOT NULL,
      game TEXT NOT NULL,
      session TEXT NOT NULL,
      note_type TEXT NOT NULL,
      note_json TEXT NOT NULL,
      PRIMARY KEY(run_id, game, session, note_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_temp_preview_draws_run_stream
      ON temp_preview_draws(run_id, game, session, draw_date)`
  ];
  for (const sql of schema) await db.execute(sql);

  await db.execute({
    sql: `INSERT INTO temp_preview_runs
      (run_id,created_at,expires_at,sample_size_per_stream,source_count,draw_rows,status,report_json)
      VALUES(?,?,?,?,?,?,?,?)`,
    args: [runId, createdAt.toISOString(), expiresAt.toISOString(), SAMPLE_SIZE,
      fetched.length, report.draw_rows, "loading", JSON.stringify(report)]
  });
  runInserted = true;

  const drawStatements = [];
  const noteStatements = [];
  for (const item of fetched) {
    const summary = streams.find((stream) => stream.source_file === item.source.filename);
    item.sample.forEach((draw, index) => drawStatements.push({
      sql: `INSERT INTO temp_preview_draws
        (run_id,game,session,draw_date,numbers_json,number_sum,sample_index,source_file,source_sha256)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      args: [runId, item.source.game, item.source.session, draw.draw_date,
        JSON.stringify(draw.numbers), draw.numbers.reduce((a, b) => a + b, 0),
        index + 1, item.source.filename, item.sourceHash]
    }));
    noteStatements.push({
      sql: `INSERT INTO temp_preview_notes
        (run_id,game,session,note_type,note_json) VALUES(?,?,?,?,?)`,
      args: [runId, item.source.game, item.source.session, "stream_summary", JSON.stringify(summary)]
    });
    noteStatements.push({
      sql: `INSERT INTO temp_preview_notes
        (run_id,game,session,note_type,note_json) VALUES(?,?,?,?,?)`,
      args: [runId, item.source.game, item.source.session, "number_frequency", JSON.stringify(summary.top_numbers)]
    });
  }

  for (let i = 0; i < drawStatements.length; i += 200) {
    await db.batch(drawStatements.slice(i, i + 200), "write");
  }
  await db.batch(noteStatements, "write");

  await db.execute({
    sql: "UPDATE temp_preview_runs SET status='complete' WHERE run_id=?",
    args: [runId]
  });

  const verify = await db.execute({
    sql: "SELECT COUNT(*) AS draw_rows, COUNT(DISTINCT game || '|' || session) AS streams FROM temp_preview_draws WHERE run_id=?",
    args: [runId]
  });
  const verifiedRows = Number(verify.rows[0]?.draw_rows || 0);
  const verifiedStreams = Number(verify.rows[0]?.streams || 0);
  if (verifiedRows !== report.draw_rows || verifiedStreams !== 12) {
    throw new Error(`Turso preview verification failed: expected ${report.draw_rows} rows / 12 streams, found ${verifiedRows} / ${verifiedStreams}`);
  }

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(`${outputDirectory}/turso-temp-preview.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(`${outputDirectory}/turso-temp-preview.md`, toMarkdown(report));
  await writeFile(`${outputDirectory}/turso-temp-preview.csv`, toCsv(report, loaded));
  await writeFile(`${outputDirectory}/turso-temp-preview-run-id.txt`, runId + "\n");

  console.log(JSON.stringify({
    status: "complete",
    run_id: runId,
    expires_at: expiresAt.toISOString(),
    source_count: fetched.length,
    streams: verifiedStreams,
    draw_rows: verifiedRows,
    canonical_session_draws_modified: false,
    board_replay_tables_modified: false,
    d1_or_r2_used: false,
    report_files: [
      "turso-temp-preview.json",
      "turso-temp-preview.md",
      "turso-temp-preview.csv"
    ]
  }, null, 2));
} catch (error) {
  if (db && runInserted) {
    try {
      await db.execute({
        sql: "UPDATE temp_preview_runs SET status='failed' WHERE run_id=?",
        args: [runId]
      });
    } catch {}
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
