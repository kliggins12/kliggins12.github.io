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
// Keep a 20,000-row reserve below the intended 80,000-row safety guard.
// D1 Insights can lag, so the durable per-UTC-day ledger below is authoritative
// for this script's own reservations across separate workflow runs.
const HARD_WRITE_BUDGET = 60_000;
const ESTIMATED_WRITES_PER_DRAW = 6; // observed amplification: 5 D1 rows_written per draw
const PAGE_SIZE = 100; // bound worst-case overshoot if D1 reports higher amplification
const MAX_DRAW_ROWS = Number(process.env.MAX_DRAW_ROWS || 5_000);

function assertConfig() {
  for (const [label, value] of [
    ["CLOUDFLARE_D1_TOKEN", PRIMARY.token],
    ["CLOUDFLARE_BACKUP_D1_TOKEN", BACKUP.token]
  ]) {
    if (!value) throw new Error("Missing required GitHub secret: " + label);
  }
  if (!Number.isSafeInteger(MAX_DRAW_ROWS) || MAX_DRAW_ROWS < 1 || MAX_DRAW_ROWS > 5_000) {
    throw new Error("MAX_DRAW_ROWS must be an integer from 1 to 5000.");
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


async function ensureBudgetTable() {
  await query(BACKUP, `
    CREATE TABLE IF NOT EXISTS backup_seed_budget (
      utc_day TEXT PRIMARY KEY,
      reserved_rows INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
}

async function reserveWriteBudget(rows, reason) {
  const reserve = Math.max(0, Math.ceil(Number(rows) || 0));
  if (!reserve) return;
  const utcDay = new Date().toISOString().slice(0, 10);
  const usage = await usageToday();
  const ledger = await query(BACKUP,
    "SELECT reserved_rows AS value FROM backup_seed_budget WHERE utc_day=?",
    [utcDay]
  );
  const alreadyReserved = Number(ledger.results?.[0]?.value || 0);
  // Use the larger of delayed analytics and our durable estimate. This avoids
  // double-counting our own writes while still respecting higher observed use.
  const baseline = Math.max(usage.rowsWritten, alreadyReserved);
  if (baseline + reserve > HARD_WRITE_BUDGET) {
    throw new Error(
      `Backup D1 write budget blocked before ${reason}: observed=${usage.rowsWritten}, ` +
      `reserved=${alreadyReserved}, requested=${reserve}, hard budget=${HARD_WRITE_BUDGET}. ` +
      "No further writes were issued."
    );
  }
  const result = await query(BACKUP, `
    INSERT INTO backup_seed_budget(utc_day,reserved_rows,updated_at)
    VALUES(?,?,?)
    ON CONFLICT(utc_day) DO UPDATE SET
      reserved_rows=backup_seed_budget.reserved_rows+excluded.reserved_rows,
      updated_at=excluded.updated_at
    WHERE backup_seed_budget.reserved_rows+excluded.reserved_rows<=?
    RETURNING reserved_rows
  `, [utcDay, reserve, new Date().toISOString(), HARD_WRITE_BUDGET]);
  if (!result.results?.length) {
    throw new Error(`Backup D1 daily write reservation refused for ${reason}; stopping before data writes.`);
  }
}

async function copyMetadata() {
  // Copy audit-run metadata first. Do not copy source hash pointers yet:
  // Backup must not advertise a source as current until every drawing row
  // from Main has been copied and verified.
  const runs = (await query(PRIMARY,
    "SELECT id,started_at,finished_at,status,files_expected,files_updated,error FROM ingestion_runs ORDER BY id"
  )).results || [];

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

  await reserveWriteBudget(runStatements.length * ESTIMATED_WRITES_PER_DRAW + 10, "ingestion-run metadata");
  const rowsWritten = await batch(BACKUP, runStatements);
  return { ingestionRuns: runs.length, rowsWritten };
}

async function copySourceFiles() {
  const sources = (await query(PRIMARY,
    "SELECT filename,source_url,sha256,bytes,row_count,fetched_at,last_modified,etag,r2_key FROM source_files ORDER BY filename"
  )).results || [];

  const statements = sources.map((row) => rowInsert(
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

  await reserveWriteBudget(statements.length * 10 + 10, "source-file metadata");
  const rowsWritten = await batch(BACKUP, statements);
  return { sourceFiles: sources.length, rowsWritten };
}

async function copyDraws(maxRows) {
  const mainCount = await scalar(PRIMARY, "SELECT COUNT(*) AS value FROM draws");
  const before = (await query(BACKUP, `
    SELECT COUNT(*) AS row_count,COALESCE(MIN(id),0) AS min_id,
           COALESCE(MAX(id),0) AS max_id,COALESCE(SUM(id),0) AS id_sum
    FROM draws
  `)).results?.[0] || {};
  const backupCountBefore = Number(before.row_count || 0);
  const backupMaxId = Number(before.max_id || 0);
  const expectedIdSum = backupMaxId * (backupMaxId + 1) / 2;
  // A count/min/max/sum check proves the existing IDs are exactly 1..MAX.
  // If not, rescan Main from ID 0 and repair holes instead of trusting MAX(id).
  const existingIdsContiguous =
    backupCountBefore === backupMaxId &&
    Number(before.min_id || 0) === (backupCountBefore ? 1 : 0) &&
    Number(before.id_sum || 0) === expectedIdSum;

  let scanAfterId = existingIdsContiguous ? backupMaxId : 0;
  let copied = 0;
  let rowsWritten = 0;
  let scanned = 0;

  while (copied < maxRows) {
    const page = (await query(PRIMARY,
      `SELECT id,source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at
       FROM draws WHERE id>? ORDER BY id LIMIT ?`,
      [scanAfterId, PAGE_SIZE]
    )).results || [];
    if (!page.length) break;

    let toWrite = page;
    if (!existingIdsContiguous) {
      const ids = page.map((row) => Number(row.id));
      const existing = (await query(BACKUP, `
        SELECT id,source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at
        FROM draws WHERE id IN (${ids.join(",")})
      `)).results || [];
      const byId = new Map(existing.map((row) => [Number(row.id), row]));
      const same = (a, b) =>
        !!b &&
        String(a.source_filename) === String(b.source_filename) &&
        String(a.game) === String(b.game) &&
        String(a.session) === String(b.session) &&
        String(a.draw_date) === String(b.draw_date) &&
        String(a.numbers_json) === String(b.numbers_json) &&
        String(a.source_sha256) === String(b.source_sha256) &&
        String(a.imported_at) === String(b.imported_at);
      toWrite = page.filter((row) => !same(row, byId.get(Number(row.id))));
    }

    if (toWrite.length) {
      // Reserve before issuing the D1 batch. Six writes per draw is above the
      // observed five-write amplification; the 20k daily margin absorbs drift.
      const estimate = toWrite.length * ESTIMATED_WRITES_PER_DRAW + 10;
      await reserveWriteBudget(estimate, "draw batch");
      const statements = toWrite.map((row) => rowInsert(
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
      if (written > estimate) {
        throw new Error(
          `D1 write amplification exceeded the reserved estimate (${written} > ${estimate}); ` +
          "stopping immediately. Do not rerun until the daily usage is reviewed."
        );
      }
      copied += toWrite.length;
    }

    scanned += page.length;
    scanAfterId = Number(page[page.length - 1].id);
    process.stdout.write(
      `Scanned through Main draw ID ${scanAfterId}: ${scanned.toLocaleString()} scanned, ` +
      `${copied.toLocaleString()} copied/repaired this run; ${rowsWritten.toLocaleString()} D1 rows written.\\n`
    );
  }

  const after = (await query(BACKUP, `
    SELECT COUNT(*) AS row_count,COALESCE(MIN(id),0) AS min_id,
           COALESCE(MAX(id),0) AS max_id,COALESCE(SUM(id),0) AS id_sum
    FROM draws
  `)).results?.[0] || {};
  const backupCountAfter = Number(after.row_count || 0);
  const mainIdStats = (await query(PRIMARY, `
    SELECT COUNT(*) AS row_count,COALESCE(MIN(id),0) AS min_id,
           COALESCE(MAX(id),0) AS max_id,COALESCE(SUM(id),0) AS id_sum
    FROM draws
  `)).results?.[0] || {};
  const coverageMatch =
    backupCountAfter === mainCount &&
    Number(after.row_count || 0) === Number(mainIdStats.row_count || 0) &&
    Number(after.min_id || 0) === Number(mainIdStats.min_id || 0) &&
    Number(after.max_id || 0) === Number(mainIdStats.max_id || 0) &&
    Number(after.id_sum || 0) === Number(mainIdStats.id_sum || 0);

  return {
    mainDraws: mainCount,
    backupDrawsBefore: backupCountBefore,
    backupDrawsAfter: backupCountAfter,
    copiedThisRun: copied,
    scannedThisRun: scanned,
    rowsWrittenThisRun: rowsWritten,
    resumeMode: existingIdsContiguous ? "after-contiguous-backup-high-watermark" : "full-scan-repair-missing-or-mismatched-ids",
    nextMainId: scanAfterId,
    complete: coverageMatch
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

  const mainIds = (await query(PRIMARY, "SELECT COUNT(*) AS row_count,COALESCE(MIN(id),0) AS min_id,COALESCE(MAX(id),0) AS max_id,COALESCE(SUM(id),0) AS id_sum FROM draws")).results?.[0] || {};
  const backupIds = (await query(BACKUP, "SELECT COUNT(*) AS row_count,COALESCE(MIN(id),0) AS min_id,COALESCE(MAX(id),0) AS max_id,COALESCE(SUM(id),0) AS id_sum FROM draws")).results?.[0] || {};
  const idCoverageMatch = JSON.stringify(mainIds) === JSON.stringify(backupIds);
  const groupsMatch = JSON.stringify(mainGroups) === JSON.stringify(backupGroups);
  return {
    main, backup, sourceGroupsMatch: groupsMatch, idCoverageMatch,
    drawDataMatch: main.draws === backup.draws && idCoverageMatch && groupsMatch
  };
}

async function main() {
  assertConfig();
  // Check delayed Cloudflare usage analytics before even creating the ledger table.
  // If the current UTC-day guard is already exceeded, this invocation is read-only.
  const initialUsage = await usageToday();
  if (initialUsage.rowsWritten >= WRITE_GUARD) {
    throw new Error("Backup D1 has reached the observed 80,000-row write guard. No database writes will be attempted.");
  }
  await ensureBudgetTable();

  const [primaryDrawCount, backupDrawCount] = await Promise.all([
    scalar(PRIMARY, "SELECT COUNT(*) AS value FROM draws"),
    scalar(BACKUP, "SELECT COUNT(*) AS value FROM draws")
  ]);
  process.stdout.write(
    `Main D1 drawings: ${primaryDrawCount}; Backup D1 drawings: ${backupDrawCount}; ` +
    `Backup D1 rows written today (UTC): ${initialUsage.rowsWritten}; per-run max: ${MAX_DRAW_ROWS}.\\n`
  );

  const metadata = await copyMetadata();
  process.stdout.write(
    `Audit metadata sync: ${metadata.ingestionRuns} ingestion runs, ${metadata.rowsWritten} rows written.\\n`
  );

  // MAX_DRAW_ROWS is a cap on rows repaired/copied, not a high-water mark.
  // copyDraws validates continuity and rescans from ID 0 if gaps exist.
  const draws = await copyDraws(MAX_DRAW_ROWS);
  const prePromotion = await verify();

  let sourceMetadata = { sourceFiles: 0, rowsWritten: 0, promoted: false };
  if (prePromotion.drawDataMatch && draws.complete) {
    sourceMetadata = { ...(await copySourceFiles()), promoted: true };
  } else {
    process.stdout.write("Drawing transfer is incomplete or mismatched; source hash metadata remains unpromoted.\\n");
  }

  const verification = await verify();
  const complete =
    draws.complete &&
    verification.drawDataMatch &&
    verification.backup.sources === verification.main.sources &&
    verification.backup.runs === verification.main.runs &&
    sourceMetadata.promoted;

  process.stdout.write(JSON.stringify({ metadata, draws, sourceMetadata, verification, complete }, null, 2) + "\\n");

  if (!complete) {
    throw new Error(
      "Backup seed verification FAILED: transfer is incomplete or metadata does not match Main. " +
      "Workflow must remain failed; do not enable failover or production ingestion."
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
