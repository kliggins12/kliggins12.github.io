import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { MIGRATION_KEY, SOURCE_CATALOG, normalizeDrawRow, normalizeSourceFile, normalizeIngestionRun } from "./lib/full-history.mjs";

const WORKER_URL = (process.env.WORKER_URL || "https://batchmate-data.kamika-us.workers.dev").replace(/\/+$/, "");
const DATABASE_URL = process.env.TURSO_DATABASE_URL;
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 100;
const APPLY = process.argv.includes("--apply");

if (!DATABASE_URL || !AUTH_TOKEN) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.");
}
if (APPLY && process.env.CONFIRM_PRIMARY_IMPORT !== "IMPORT-ALL-17-SOURCES") {
  throw new Error("Import blocked. Set CONFIRM_PRIMARY_IMPORT=IMPORT-ALL-17-SOURCES and pass --apply.");
}
if (process.argv.some((arg) => arg.startsWith("--") && arg !== "--apply")) {
  throw new Error("Only --apply is supported. Without it, the script performs a read-only report.");
}

function fingerprint(rows) {
  const canonical = [...rows]
    .sort((a, b) =>
      a.source_filename.localeCompare(b.source_filename) ||
      a.draw_date.localeCompare(b.draw_date)
    )
    .map((row) => [
      row.source_filename,
      row.game,
      row.session,
      row.draw_date,
      row.numbers_json,
      row.source_sha256,
      row.imported_at
    ].join("\t"))
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function readWorkerSource(source) {
  const allRows = [];
  const seenDates = new Set();
  let before = null;

  for (;;) {
    const params = new URLSearchParams({
      game: source.game,
      session: source.session,
      limit: String(PAGE_SIZE)
    });
    if (before) params.set("before", before);

    const response = await fetch(WORKER_URL + "/api/draws?" + params.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(55000)
    });
    if (!response.ok) {
      throw new Error(`D1 read failed for ${source.filename}: HTTP ${response.status}.`);
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.draws)) {
      throw new Error(`Unexpected response while reading ${source.filename}.`);
    }
    if (payload.draws.length > PAGE_SIZE) {
      throw new Error(`Worker returned more than ${PAGE_SIZE} rows for ${source.filename}.`);
    }

    const page = payload.draws.map((row) => normalizeDrawRow(row, source));
    for (let index = 0; index < page.length; index++) {
      const draw = page[index];
      if (seenDates.has(draw.draw_date)) {
        throw new Error(`Duplicate draw date ${draw.draw_date} in ${source.filename}.`);
      }
      seenDates.add(draw.draw_date);
      if (index > 0 && draw.draw_date >= page[index - 1].draw_date) {
        throw new Error(`D1 pagination is not strictly descending for ${source.filename}.`);
      }
      if (before && draw.draw_date >= before) {
        throw new Error(`D1 pagination cursor did not advance for ${source.filename}.`);
      }
    }

    allRows.push(...page);
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1].draw_date;
  }

  if (allRows.length === 0) {
    throw new Error(`No drawings were returned for ${source.filename}; refusing an incomplete import.`);
  }

  return allRows;
}

async function readTursoSource(db, source) {
  const result = await db.execute({
    sql: `SELECT source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at
          FROM lottery_draws WHERE source_filename=? ORDER BY draw_date ASC`,
    args: [source.filename]
  });
  return result.rows.map((row) => normalizeDrawRow({
    source_filename: String(row.source_filename),
    game: String(row.game),
    session: String(row.session),
    draw_date: String(row.draw_date),
    numbers_json: String(row.numbers_json),
    source_sha256: String(row.source_sha256),
    imported_at: String(row.imported_at)
  }, source));
}

async function writeSource(db, source, rows) {
  const insertSql = `INSERT INTO lottery_draws
    (source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(source_filename,draw_date) DO UPDATE SET
      game=excluded.game,
      session=excluded.session,
      numbers_json=excluded.numbers_json,
      source_sha256=excluded.source_sha256,
      imported_at=excluded.imported_at
    WHERE lottery_draws.game IS NOT excluded.game
       OR lottery_draws.session IS NOT excluded.session
       OR lottery_draws.numbers_json IS NOT excluded.numbers_json
       OR lottery_draws.source_sha256 IS NOT excluded.source_sha256
       OR lottery_draws.imported_at IS NOT excluded.imported_at`;

  let changedRows = 0;
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + WRITE_BATCH_SIZE).map((row) => ({
      sql: insertSql,
      args: [
        row.source_filename,
        row.game,
        row.session,
        row.draw_date,
        row.numbers_json,
        row.source_sha256,
        row.imported_at
      ]
    }));
    const result = await db.batch(batch, "write");
    changedRows += result.reduce((sum, item) =>
      sum + Number(item?.rowsAffected ?? item?.rows_affected ?? 0), 0
    );
  }
  return changedRows;
}


function fingerprintMetadata(rows, keyName) {
  const canonical = [...rows]
    .sort((a, b) => String(a[keyName]).localeCompare(String(b[keyName])))
    .map((row) => JSON.stringify(row))
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function readWorkerSourceFiles() {
  const response = await fetch(WORKER_URL + "/api/migration/source-files", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(55000)
  });
  if (!response.ok) throw new Error("D1 source-file metadata read failed: HTTP " + response.status + ".");
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.sources)) throw new Error("Unexpected D1 source-file metadata response.");

  const byName = new Map(SOURCE_CATALOG.map((source) => [source.filename, source]));
  const seen = new Set();
  const rows = payload.sources.map((row) => {
    const filename = String(row.filename ?? "");
    const source = byName.get(filename);
    if (!source || seen.has(filename)) throw new Error("Unknown or duplicate source metadata file: " + filename + ".");
    seen.add(filename);
    return normalizeSourceFile(row, source);
  });
  if (rows.length !== SOURCE_CATALOG.length || seen.size !== SOURCE_CATALOG.length) {
    throw new Error("D1 source metadata is incomplete: expected " + SOURCE_CATALOG.length + ", found " + rows.length + ".");
  }
  return rows.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function readWorkerIngestionRuns() {
  const allRows = [];
  const seen = new Set();
  let before = null;
  for (;;) {
    const params = new URLSearchParams({ limit: "200" });
    if (before !== null) params.set("before", String(before));
    const response = await fetch(WORKER_URL + "/api/migration/ingestion-runs?" + params.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(55000)
    });
    if (!response.ok) throw new Error("D1 ingestion-run metadata read failed: HTTP " + response.status + ".");
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.runs)) throw new Error("Unexpected D1 ingestion-run response.");

    const page = payload.runs.map(normalizeIngestionRun);
    for (let i = 0; i < page.length; i++) {
      const row = page[i];
      if (seen.has(row.id)) throw new Error("Duplicate D1 ingestion run ID: " + row.id + ".");
      if (i > 0 && row.id >= page[i - 1].id) throw new Error("D1 ingestion-run pagination is not strictly descending.");
      if (before !== null && row.id >= before) throw new Error("D1 ingestion-run pagination cursor did not advance.");
      seen.add(row.id);
    }
    allRows.push(...page);
    if (page.length < 200) break;
    const next = Number(payload.nextBefore ?? page[page.length - 1]?.id);
    if (!Number.isSafeInteger(next) || next <= 0 || (before !== null && next >= before)) {
      throw new Error("D1 ingestion-run pagination returned an invalid cursor.");
    }
    before = next;
  }
  return allRows.sort((a, b) => a.id - b.id);
}

async function readTursoSourceFiles(db) {
  const result = await db.execute(
    "SELECT filename,source_url,sha256,bytes,row_count,fetched_at,last_modified,etag,r2_key FROM source_files ORDER BY filename"
  );
  const byName = new Map(SOURCE_CATALOG.map((source) => [source.filename, source]));
  return result.rows.map((row) => {
    const filename = String(row.filename);
    const source = byName.get(filename);
    if (!source) throw new Error("Unexpected source metadata in Turso: " + filename + ".");
    return normalizeSourceFile({
      filename,
      source_url: String(row.source_url),
      sha256: String(row.sha256),
      bytes: Number(row.bytes),
      row_count: Number(row.row_count),
      fetched_at: String(row.fetched_at),
      last_modified: row.last_modified == null ? null : String(row.last_modified),
      etag: row.etag == null ? null : String(row.etag),
      r2_key: String(row.r2_key)
    }, source);
  });
}

async function readTursoIngestionRuns(db) {
  const result = await db.execute(
    "SELECT id,started_at,finished_at,status,files_expected,files_updated,error FROM ingestion_runs ORDER BY id"
  );
  return result.rows.map((row) => normalizeIngestionRun({
    id: Number(row.id),
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    status: String(row.status),
    files_expected: Number(row.files_expected),
    files_updated: Number(row.files_updated),
    error: row.error == null ? null : String(row.error)
  }));
}

async function writeSourceMetadata(db, rows) {
  const sql = `INSERT INTO source_files
    (filename,source_url,sha256,bytes,row_count,fetched_at,last_modified,etag,r2_key)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(filename) DO UPDATE SET
      source_url=excluded.source_url, sha256=excluded.sha256, bytes=excluded.bytes,
      row_count=excluded.row_count, fetched_at=excluded.fetched_at,
      last_modified=excluded.last_modified, etag=excluded.etag, r2_key=excluded.r2_key
    WHERE source_files.source_url IS NOT excluded.source_url
       OR source_files.sha256 IS NOT excluded.sha256
       OR source_files.bytes IS NOT excluded.bytes
       OR source_files.row_count IS NOT excluded.row_count
       OR source_files.fetched_at IS NOT excluded.fetched_at
       OR source_files.last_modified IS NOT excluded.last_modified
       OR source_files.etag IS NOT excluded.etag
       OR source_files.r2_key IS NOT excluded.r2_key`;
  const statements = rows.map((row) => ({
    sql,
    args: [row.filename,row.source_url,row.sha256,row.bytes,row.row_count,row.fetched_at,row.last_modified,row.etag,row.r2_key]
  }));
  let changed = 0;
  for (let i = 0; i < statements.length; i += WRITE_BATCH_SIZE) {
    const result = await db.batch(statements.slice(i, i + WRITE_BATCH_SIZE), "write");
    changed += result.reduce((sum, item) => sum + Number(item?.rowsAffected ?? item?.rows_affected ?? 0), 0);
  }
  return changed;
}

async function writeIngestionRuns(db, rows) {
  const sql = `INSERT INTO ingestion_runs
    (id,started_at,finished_at,status,files_expected,files_updated,error)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      started_at=excluded.started_at, finished_at=excluded.finished_at,
      status=excluded.status, files_expected=excluded.files_expected,
      files_updated=excluded.files_updated, error=excluded.error
    WHERE ingestion_runs.started_at IS NOT excluded.started_at
       OR ingestion_runs.finished_at IS NOT excluded.finished_at
       OR ingestion_runs.status IS NOT excluded.status
       OR ingestion_runs.files_expected IS NOT excluded.files_expected
       OR ingestion_runs.files_updated IS NOT excluded.files_updated
       OR ingestion_runs.error IS NOT excluded.error`;
  const statements = rows.map((row) => ({
    sql,
    args: [row.id,row.started_at,row.finished_at,row.status,row.files_expected,row.files_updated,row.error]
  }));
  let changed = 0;
  for (let i = 0; i < statements.length; i += WRITE_BATCH_SIZE) {
    const result = await db.batch(statements.slice(i, i + WRITE_BATCH_SIZE), "write");
    changed += result.reduce((sum, item) => sum + Number(item?.rowsAffected ?? item?.rows_affected ?? 0), 0);
  }
  return changed;
}

async function main() {
  const db = createClient({ url: DATABASE_URL, authToken: AUTH_TOKEN });
const runId = randomUUID();
const startedAt = new Date().toISOString();
const report = {
  migration_key: MIGRATION_KEY,
  run_id: runId,
  mode: APPLY ? "apply" : "read-only report",
  generated_at: startedAt,
  worker_url: WORKER_URL,
  status: "FAIL",
  total_source_files: SOURCE_CATALOG.length,
  total_draws: 0,
  verified_draws: 0,
  sources: [],
  writes_estimated: 0,
  errors: []
};

let runCreated = false;
try {
  // Probe the target schema before reading 84k+ rows from the source API.
  await db.execute("SELECT source_filename FROM lottery_draws LIMIT 0");
  await db.execute("SELECT filename FROM source_files LIMIT 0");
  await db.execute("SELECT id FROM ingestion_runs LIMIT 0");

  const sourceData = [];
  for (const source of SOURCE_CATALOG) {
    process.stdout.write(`Reading ${source.filename}…\n`);
    const rows = await readWorkerSource(source);
    const sourceFingerprint = fingerprint(rows);
    const existing = await readTursoSource(db, source);
    const targetFingerprint = fingerprint(existing);
    const matches = rows.length === existing.length && sourceFingerprint === targetFingerprint;

    sourceData.push({ source, rows, sourceFingerprint, existing, matches });
    report.total_draws += rows.length;
    report.sources.push({
      filename: source.filename,
      game: source.game,
      session: source.session,
      source_rows: rows.length,
      target_rows: existing.length,
      first_draw_date: rows.reduce((min, row) => row.draw_date < min ? row.draw_date : min, rows[0].draw_date),
      latest_draw_date: rows.reduce((max, row) => row.draw_date > max ? row.draw_date : max, rows[0].draw_date),
      source_fingerprint: sourceFingerprint,
      target_matches: matches
    });
  }

  process.stdout.write("Reading source-file and ingestion metadata…\\n");
  const sourceFiles = await readWorkerSourceFiles();
  const ingestionRuns = await readWorkerIngestionRuns();
  const tursoSourceFiles = await readTursoSourceFiles(db);
  const tursoIngestionRuns = await readTursoIngestionRuns(db);
  const sourceFilesMatch = sourceFiles.length === tursoSourceFiles.length &&
    fingerprintMetadata(sourceFiles, "filename") === fingerprintMetadata(tursoSourceFiles, "filename");
  const ingestionRunsMatch = ingestionRuns.length === tursoIngestionRuns.length &&
    fingerprintMetadata(ingestionRuns, "id") === fingerprintMetadata(tursoIngestionRuns, "id");
  report.metadata = {
    source_files: { source_rows: sourceFiles.length, target_rows: tursoSourceFiles.length, matches: sourceFilesMatch },
    ingestion_runs: { source_rows: ingestionRuns.length, target_rows: tursoIngestionRuns.length, matches: ingestionRunsMatch }
  };

  const mismatched = sourceData.filter((item) => !item.matches);
  const drawWritesEstimate = mismatched.reduce((sum, item) => sum + item.rows.length, 0);
  report.writes_estimated = drawWritesEstimate +
    (sourceFilesMatch ? 0 : sourceFiles.length) +
    (ingestionRunsMatch ? 0 : ingestionRuns.length);

  if (!APPLY) {
    const hasMismatch = mismatched.length > 0 || !sourceFilesMatch || !ingestionRunsMatch;
    report.status = hasMismatch ? "READY_FOR_REVIEW" : "ALREADY_MATCHES";
    report.verified_draws = sourceData.filter((item) => item.matches).reduce((sum, item) => sum + item.rows.length, 0);
    process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
    if (hasMismatch) process.stdout.write("Read-only report complete. No Turso rows were written.\\n");
    return;
  }

  await db.execute({
    sql: `INSERT INTO migration_runs
      (run_id,migration_key,started_at,status,source_count,draws_expected,draws_verified)
      VALUES(?,?,?,?,?,?,0)`,
    args: [runId, MIGRATION_KEY, startedAt, "running", SOURCE_CATALOG.length, report.total_draws]
  });
  runCreated = true;

  let verifiedTotal = 0;
  let sourceIndex = 0;
  for (const item of sourceData) {
    sourceIndex++;
    const { source, rows, sourceFingerprint, matches } = item;
    let changed = 0;
    if (!matches) changed = await writeSource(db, source, rows);

    const verifyRows = await readTursoSource(db, source);
    const verified = verifyRows.length === rows.length && fingerprint(verifyRows) === sourceFingerprint;
    if (!verified) {
      throw new Error(`Exact verification failed for ${source.filename}: source=${rows.length}, Turso=${verifyRows.length}.`);
    }
    verifiedTotal += rows.length;
    await db.execute({
      sql: `INSERT INTO migration_source_progress
        (migration_key,source_filename,status,row_count,first_draw_date,latest_draw_date,source_fingerprint,verified_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(migration_key,source_filename) DO UPDATE SET
          status=excluded.status,
          row_count=excluded.row_count,
          first_draw_date=excluded.first_draw_date,
          latest_draw_date=excluded.latest_draw_date,
          source_fingerprint=excluded.source_fingerprint,
          verified_at=excluded.verified_at`,
      args: [
        MIGRATION_KEY,
        source.filename,
        "complete",
        rows.length,
        report.sources[sourceIndex - 1].first_draw_date,
        report.sources[sourceIndex - 1].latest_draw_date,
        sourceFingerprint,
        new Date().toISOString()
      ]
    });
    report.sources[sourceIndex - 1].changed_rows = changed;
    report.sources[sourceIndex - 1].verified = true;
    process.stdout.write(`Verified ${source.filename}: ${rows.length} rows; ${changed} changed.\n`);
  }

  report.verified_draws = verifiedTotal;
  const sourceFilesChanged = await writeSourceMetadata(db, sourceFiles);
  const verifiedSourceFiles = await readTursoSourceFiles(db);
  const sourceFilesVerified = verifiedSourceFiles.length === sourceFiles.length &&
    fingerprintMetadata(sourceFiles, "filename") === fingerprintMetadata(verifiedSourceFiles, "filename");
  if (!sourceFilesVerified) throw new Error("Exact source_files metadata verification failed.");

  const ingestionRunsChanged = await writeIngestionRuns(db, ingestionRuns);
  const verifiedIngestionRuns = await readTursoIngestionRuns(db);
  const ingestionRunsVerified = verifiedIngestionRuns.length === ingestionRuns.length &&
    fingerprintMetadata(ingestionRuns, "id") === fingerprintMetadata(verifiedIngestionRuns, "id");
  if (!ingestionRunsVerified) throw new Error("Exact ingestion_runs metadata verification failed.");

  report.metadata.source_files.changed_rows = sourceFilesChanged;
  report.metadata.source_files.verified = true;
  report.metadata.ingestion_runs.changed_rows = ingestionRunsChanged;
  report.metadata.ingestion_runs.verified = true;
  report.status = "SUCCESS";
  await db.execute({
    sql: "UPDATE migration_runs SET finished_at=?,status='success',draws_verified=? WHERE run_id=?",
    args: [new Date().toISOString(), verifiedTotal, runId]
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  report.status = "FAIL";
  report.errors.push(error instanceof Error ? error.message : String(error));
  if (runCreated) {
    try {
      await db.execute({
        sql: "UPDATE migration_runs SET finished_at=?,status='failed',error=? WHERE run_id=?",
        args: [new Date().toISOString(), report.errors[0], runId]
      });
    } catch (ledgerError) {
      report.errors.push("Could not update migration ledger: " + (ledgerError instanceof Error ? ledgerError.message : String(ledgerError)));
    }
  }
  process.stderr.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = 1;
} finally {
  await db.close();
}
}

await main();
