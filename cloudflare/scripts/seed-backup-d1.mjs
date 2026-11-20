const API = "https://api.cloudflare.com/client/v4";
const PRIMARY = {
  account: process.env.PRIMARY_ACCOUNT_ID || "41745143f8e073c6d617c36b04d1b5cd",
  database: process.env.PRIMARY_D1_ID || "1180909a-5bac-4747-87ce-e3293fe61163",
  token: process.env.CLOUDFLARE_D1_TOKEN
};
const BACKUP = {
  account: process.env.BACKUP_ACCOUNT_ID || "837536310e0248f357e04b157577494b",
  database: process.env.BACKUP_D1_ID || "3482ac37-d463-4efc-b6cc-b77dd6f35dd2",
  token: process.env.CLOUDFLARE_BACKUP_D1_TOKEN
};

const WRITE_GUARD = 80_000;
const PAGE_SIZE = 500;
const MAX_DRAW_ROWS = Number(process.env.MAX_DRAW_ROWS || 60_000);

function assertConfig() {
  for (const [label, value] of [
    ["CLOUDFLARE_D1_TOKEN", PRIMARY.token],
    ["CLOUDFLARE_BACKUP_D1_TOKEN", BACKUP.token]
  ]) {
    if (!value) throw new Error("Missing required GitHub secret: " + label);
  }
  if (!Number.isSafeInteger(MAX_DRAW_ROWS) || MAX_DRAW_ROWS < 1 || MAX_DRAW_ROWS > 70_000) {
    throw new Error("MAX_DRAW_ROWS must be an integer from 1 to 70000.");
  }
}

async function requestJson(url, options, label) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, options);
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.success !== false) return body;
      const detail = body.errors?.map((item) => item.message).join("; ") ||
        response.statusText || "Unknown Cloudflare API error";
      const error = new Error(label + " failed (" + response.status + "): " + detail);
      if (response.status === 429 || response.status >= 500) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * (2 ** attempt))));
        continue;
      }
      throw error;
    } catch (error) {
      if (attempt === 5) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * (2 ** attempt))));
    }
  }
  throw lastError || new Error(label + " failed after retries");
}

async function query(connection, sql, params = []) {
  const body = await requestJson(
    `${API}/accounts/${connection.account}/d1/database/${connection.database}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + connection.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sql, params: params.map((value) => String(value)) })
    },
    "D1 query"
  );
  const result = body.result?.[0];
  if (!result?.success) throw new Error("D1 query did not return a successful result");
  return result;
}

async function batch(connection, statements) {
  if (!statements.length) return 0;
  const body = await requestJson(
    `${API}/accounts/${connection.account}/d1/database/${connection.database}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + connection.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ batch: statements.map((sql) => ({ sql })) })
    },
    "D1 batch"
  );
  const results = body.result || [];
  if (results.some((result) => result.success === false)) {
    throw new Error("One or more statements in a D1 batch failed");
  }
  return results.reduce((sum, result) => sum + Number(result.meta?.rows_written || 0), 0);
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function rowInsert(table, columns, values, conflictSql) {
  const valueSql = values.map(literal).join(",");
  return `INSERT INTO ${table}(${columns.join(",")}) VALUES(${valueSql}) ${conflictSql}`;
}

async function usageToday() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const body = await requestJson(
    `${API}/accounts/${BACKUP.account}/d1/insights/databases?since=${encodeURIComponent(start)}&order_by=rows_written&database_name=batchmate-backup&exact=true&limit=20`,
    {
      method: "GET",
      headers: { "Authorization": "Bearer " + BACKUP.token }
    },
    "Backup D1 daily usage lookup"
  );
  const row = (body.result || []).find((item) => item.database_id === BACKUP.database);
  return {
    rowsWritten: Number(row?.rows_written || 0),
    utcDay: start.slice(0, 10)
  };
}

async function scalar(connection, sql) {
  const result = await query(connection, sql);
  return Number(result.results?.[0]?.value ?? 0);
}

async function copyMetadata() {
  const sources = (await query(PRIMARY,
    "SELECT filename,source_url,sha256,bytes,row_count,fetched_at,last_modified,etag,r2_key FROM source_files ORDER BY filename"
  )).results || [];
  const runs = (await query(PRIMARY,
    "SELECT id,started_at,finished_at,status,files_expected,files_updated,error FROM ingestion_runs ORDER BY id"
  )).results || [];

  const sourceStatements = sources.map((row) => rowInsert(
    "source_files",
    ["filename","source_url","sha256","bytes","row_count","fetched_at","last_modified","etag","r2_key"],
    [row.filename,row.source_url,row.sha256,row.bytes,row.row_count,row.fetched_at,row.last_modified,row.etag,row.r2_key],
    `ON CONFLICT(filename) DO UPDATE SET
      source_url=excluded.source_url,sha256=excluded.sha256,bytes=excluded.bytes,
      row_count=excluded.row_count,fetched_at=excluded.fetched_at,
      last_modified=excluded.last_modified,etag=excluded.etag,r2_key=excluded.r2_key
    WHERE source_files.source_url<>excluded.source_url OR source_files.sha256<>excluded.sha256
      OR source_files.bytes<>excluded.bytes OR source_files.row_count<>excluded.row_count
      OR source_files.fetched_at<>excluded.fetched_at
      OR COALESCE(source_files.last_modified,'')<>COALESCE(excluded.last_modified,'')
      OR COALESCE(source_files.etag,'')<>COALESCE(excluded.etag,'')
      OR source_files.r2_key<>excluded.r2_key`
  ));
  const runStatements = runs.map((row) => rowInsert(
    "ingestion_runs",
    ["id","started_at","finished_at","status","files_expected","files_updated","error"],
    [row.id,row.started_at,row.finished_at,row.status,row.files_expected,row.files_updated,row.error],
    `ON CONFLICT(id) DO UPDATE SET
      started_at=excluded.started_at,finished_at=excluded.finished_at,status=excluded.status,
      files_expected=excluded.files_expected,files_updated=excluded.files_updated,error=excluded.error
    WHERE ingestion_runs.started_at<>excluded.started_at
      OR COALESCE(ingestion_runs.finished_at,'')<>COALESCE(excluded.finished_at,'')
      OR ingestion_runs.status<>excluded.status
      OR ingestion_runs.files_expected<>excluded.files_expected
      OR ingestion_runs.files_updated<>excluded.files_updated
      OR COALESCE(ingestion_runs.error,'')<>COALESCE(excluded.error,'')`
  ));

  const writeCount = await batch(BACKUP, [...sourceStatements, ...runStatements]);
  return { sourceFiles: sources.length, ingestionRuns: runs.length, rowsWritten: writeCount };
}

async function copyDraws(maxRows) {
  const currentMax = await scalar(BACKUP, "SELECT COALESCE(MAX(id),0) AS value FROM draws");
  const mainCount = await scalar(PRIMARY, "SELECT COUNT(*) AS value FROM draws");
  const backupCountBefore = await scalar(BACKUP, "SELECT COUNT(*) AS value FROM draws");
  let lastId = currentMax;
  let copied = 0;
  let rowsWritten = 0;
  const target = Math.min(maxRows, Math.max(0, mainCount - backupCountBefore));

  while (copied < target) {
    const pageLimit = Math.min(PAGE_SIZE, target - copied);
    const page = (await query(PRIMARY,
      `SELECT id,source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at
       FROM draws WHERE id>? ORDER BY id LIMIT ?`,
      [lastId, pageLimit]
    )).results || [];
    if (!page.length) break;

    const statements = page.map((row) => rowInsert(
      "draws",
      ["id","source_filename","game","session","draw_date","numbers_json","source_sha256","imported_at"],
      [row.id,row.source_filename,row.game,row.session,row.draw_date,row.numbers_json,row.source_sha256,row.imported_at],
      `ON CONFLICT(id) DO UPDATE SET
        source_filename=excluded.source_filename,game=excluded.game,session=excluded.session,
        draw_date=excluded.draw_date,numbers_json=excluded.numbers_json,
        source_sha256=excluded.source_sha256,imported_at=excluded.imported_at
      WHERE draws.source_filename<>excluded.source_filename OR draws.game<>excluded.game
        OR draws.session<>excluded.session OR draws.draw_date<>excluded.draw_date
        OR draws.numbers_json<>excluded.numbers_json OR draws.source_sha256<>excluded.source_sha256
        OR draws.imported_at<>excluded.imported_at`
    ));

    const written = await batch(BACKUP, statements);
    rowsWritten += written;
    copied += page.length;
    lastId = Number(page[page.length - 1].id);

    process.stdout.write(
      `Copied through Main draw ID ${lastId}: ${copied.toLocaleString()} this run; ${rowsWritten.toLocaleString()} D1 rows written this run.\n`
    );

    // Re-read real daily usage after each chunk. If analytics lags, the
    // per-run count still bounds this run; the workflow is intended to be
    // run once per UTC day, below the 80% safety ceiling.
    const usage = await usageToday();
    if (usage.rowsWritten >= WRITE_GUARD) {
      process.stdout.write("Backup D1 reached the 80% write guard; stopping safely.\n");
      break;
    }
  }

  const backupCountAfter = await scalar(BACKUP, "SELECT COUNT(*) AS value FROM draws");
  return {
    mainDraws: mainCount,
    backupDrawsBefore: backupCountBefore,
    backupDrawsAfter: backupCountAfter,
    copiedThisRun: copied,
    rowsWrittenThisRun: rowsWritten,
    nextMainId: lastId < currentMax ? currentMax : lastId,
    complete: backupCountAfter >= mainCount
  };
}

async function verify() {
  const main = {
    draws: await scalar(PRIMARY, "SELECT COUNT(*) AS value FROM draws"),
    sources: await scalar(PRIMARY, "SELECT COUNT(*) AS value FROM source_files"),
    runs: await scalar(PRIMARY, "SELECT COUNT(*) AS value FROM ingestion_runs")
  };
  const backup = {
    draws: await scalar(BACKUP, "SELECT COUNT(*) AS value FROM draws"),
    sources: await scalar(BACKUP, "SELECT COUNT(*) AS value FROM source_files"),
    runs: await scalar(BACKUP, "SELECT COUNT(*) AS value FROM ingestion_runs")
  };

  const mainGroups = (await query(PRIMARY, `
    SELECT source_filename,COUNT(*) AS row_count,MIN(draw_date) AS first_date,
           MAX(draw_date) AS latest_date,SUM(length(numbers_json)) AS payload_chars,
           SUM(id) AS id_sum
    FROM draws GROUP BY source_filename ORDER BY source_filename
  `)).results || [];
  const backupGroups = (await query(BACKUP, `
    SELECT source_filename,COUNT(*) AS row_count,MIN(draw_date) AS first_date,
           MAX(draw_date) AS latest_date,SUM(length(numbers_json)) AS payload_chars,
           SUM(id) AS id_sum
    FROM draws GROUP BY source_filename ORDER BY source_filename
  `)).results || [];

  const groupsMatch = JSON.stringify(mainGroups) === JSON.stringify(backupGroups);
  return { main, backup, sourceGroupsMatch: groupsMatch };
}

async function main() {
  assertConfig();
  const [primaryDrawCount, backupDrawCount, usage] = await Promise.all([
    scalar(PRIMARY, "SELECT COUNT(*) AS value FROM draws"),
    scalar(BACKUP, "SELECT COUNT(*) AS value FROM draws"),
    usageToday()
  ]);
  const remaining = Math.max(0, primaryDrawCount - backupDrawCount);
  const requestedRows = Math.min(MAX_DRAW_ROWS, remaining);
  const metadataBudget = 60;
  const maxAllowedNow = Math.max(0, WRITE_GUARD - usage.rowsWritten - metadataBudget);
  const rowsThisRun = Math.min(requestedRows, maxAllowedNow);

  process.stdout.write(
    `Main D1 drawings: ${primaryDrawCount}; Backup D1 drawings: ${backupDrawCount}; ` +
    `Backup D1 rows written today (UTC): ${usage.rowsWritten}.\n`
  );

  if (remaining > 0 && rowsThisRun === 0) {
    throw new Error("Backup D1 is at or near the 80% daily write guard. Resume after the UTC daily reset.");
  }

  const metadata = await copyMetadata();
  process.stdout.write(
    `Metadata sync: ${metadata.sourceFiles} source files, ${metadata.ingestionRuns} ingestion runs, ` +
    `${metadata.rowsWritten} rows written.\n`
  );

  const draws = await copyDraws(rowsThisRun);
  const verification = await verify();
  process.stdout.write(JSON.stringify({ metadata, draws, verification }, null, 2) + "\n");

  if (!verification.sourceGroupsMatch && verification.backup.draws >= verification.main.draws) {
    throw new Error("Backup draw groups do not match Main. Do not activate Backup until reconciled.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
