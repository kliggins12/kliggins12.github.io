import { checkTurso, getTursoClient } from "./turso";
import { isSourceHashUnchanged, selectChangedDraws } from "./ingestion/delta";

interface Env {
  DB: D1Database;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  ARCHIVE: R2Bucket;
  API_TOKEN?: string;
  INGEST_PAUSED?: string;
}

type Source = { filename: string; url: string; game: string; session: string };

const TX_BASE = "https://www.texaslottery.com/export/sites/lottery/Games";
const TX: Source[] = [
  ...(["morning", "day", "evening", "night"] as const).map((session) => ({
    filename: `aon_${session}.csv`,
    url: `${TX_BASE}/All_or_Nothing/Winning_Numbers/allornothing${session}.csv`,
    game: "All or Nothing", session
  })),
  ...(["morning", "day", "evening", "night"] as const).map((session) => ({
    filename: `pick3${session}.csv`,
    url: `${TX_BASE}/Pick_3/Winning_Numbers/pick3${session}.csv`,
    game: "Pick 3", session
  })),
  ...(["morning", "day", "evening", "night"] as const).map((session) => ({
    filename: `daily4${session}.csv`,
    url: `${TX_BASE}/Daily_4/Winning_Numbers/daily4${session}.csv`,
    game: "Daily 4", session
  })),
  { filename: "cashfive.csv", url: `${TX_BASE}/Cash_Five/Winning_Numbers/cashfive.csv`, game: "Cash Five", session: "daily" },
  { filename: "texastwostep.csv", url: `${TX_BASE}/Texas_Two_Step/Winning_Numbers/texastwostep.csv`, game: "Texas Two Step", session: "draw" },
  { filename: "lottotexas.csv", url: `${TX_BASE}/Lotto_Texas/Winning_Numbers/lottotexas.csv`, game: "Lotto Texas", session: "draw" },
  { filename: "powerball.csv", url: "https://louisianalottery.com/csv/powerball.csv", game: "Powerball", session: "draw" },
  { filename: "megamillions.csv", url: "https://louisianalottery.com/csv/mega-millions.csv", game: "Mega Millions", session: "draw" }
];

function csvRowCount(csv: string): number {
  // Count physical records while respecting quoted newlines and escaped quotes.
  let rows = 0, quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (ch === "\n" && !quoted) rows++;
  }
  if (csv.length && !csv.endsWith("\n")) rows++;
  return Math.max(0, rows - 1); // exclude header
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CORS_HEADERS = {
  "access-control-allow-origin": "https://kliggins12.github.io",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "vary": "Origin"
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}



type ParsedDraw = { drawDate: string; numbers: number[] };

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") {
      row.push(field.replace(/\r$/, "")); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((v) => v.trim() !== "")) rows.push(row);
  }
  return rows;
}

function expectedNumbers(source: Source): number {
  if (source.game === "All or Nothing") return 12;
  if (source.game === "Pick 3") return 3;
  if (source.game === "Daily 4") return 4;
  if (source.game === "Cash Five" || source.game === "Texas Two Step") return 5;
  return 6; // Lotto Texas, Powerball, Mega Millions
}

function parseSourceDraws(csv: string, source: Source): ParsedDraw[] {
  const rows = parseCsvRows(csv);
  const parsed: ParsedDraw[] = [];
  const count = expectedNumbers(source);
  const isLouisiana = source.game === "Powerball" || source.game === "Mega Millions";

  for (const row of rows.slice(1)) {
    let drawDate: string;
    let rawNumbers: string[];
    if (isLouisiana) {
      const date = (row[0] || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      drawDate = date;
      rawNumbers = row.slice(1, 1 + count);
    } else {
      const month = Number(row[1]), day = Number(row[2]), year = Number(row[3]);
      if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year) ||
          month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) continue;
      drawDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      rawNumbers = row.slice(4, 4 + count);
    }
    if (rawNumbers.length !== count) continue;
    const numbers = rawNumbers.map((v) => Number(v.trim()));
    if (numbers.some((n) => !Number.isInteger(n) || n < 0)) continue;
    parsed.push({ drawDate, numbers });
  }
  return parsed;
}

async function reindexSource(
  env: Env,
  source: Source,
  archived?: { r2_key: string; sha256: string }
): Promise<{
  filename: string;
  parsed: number;
  imported: number;
  unchanged: number;
  tursoImported: number | null;
  tursoUnchanged: number | null;
}> {
  const record = archived ?? await env.DB.prepare("SELECT r2_key,sha256 FROM source_files WHERE filename=?")
    .bind(source.filename).first<{ r2_key: string; sha256: string }>();
  if (!record) throw new Error(`No archived source found for ${source.filename}`);
  const object = await env.ARCHIVE.get(record.r2_key);
  if (!object) throw new Error(`Archived CSV is missing for ${source.filename}`);
  const csv = await object.text();
  const draws = parseSourceDraws(csv, source);
  if (draws.length === 0) throw new Error(`No valid draw rows parsed from ${source.filename}; existing history was left unchanged`);

  const importedAt = new Date().toISOString();

  // Read the existing source history once, then write only dates that are
  // new or whose actual numbers/classification changed. A changed file hash
  // by itself must never trigger a historical rewrite.
  const existingD1 = await env.DB.prepare(`
    SELECT draw_date,game,session,numbers_json
    FROM draws
    WHERE source_filename=?
  `).bind(source.filename).all<{
    draw_date: string;
    game: string;
    session: string;
    numbers_json: string;
  }>();

  const d1Changes = selectChangedDraws(
    draws,
    existingD1.results,
    { game: source.game, session: source.session }
  );

  const d1Statements = d1Changes.map((draw) => env.DB.prepare(`
    INSERT INTO draws(source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(source_filename,draw_date) DO UPDATE SET
      game=excluded.game, session=excluded.session, numbers_json=excluded.numbers_json,
      source_sha256=excluded.source_sha256, imported_at=excluded.imported_at
  `).bind(source.filename, source.game, source.session, draw.drawDate,
    JSON.stringify(draw.numbers), record.sha256, importedAt));

  for (let i = 0; i < d1Statements.length; i += 50) {
    await env.DB.batch(d1Statements.slice(i, i + 50));
  }

  // Keep the 12 sessioned histories synchronized in Turso. Only Pick 3,
  // Daily 4, and All or Nothing are mirrored, and only changed draws are sent.
  let tursoImported: number | null = null;
  let tursoUnchanged: number | null = null;
  if (["Pick 3", "Daily 4", "All or Nothing"].includes(source.game)) {
    const turso = getTursoClient(env);
    const existingTursoResult = await turso.execute({
      sql: "SELECT draw_date,numbers FROM session_draws WHERE game=? AND session=?",
      args: [source.game, source.session]
    });
    const existingTurso = existingTursoResult.rows.map((row) => ({
      draw_date: String(row.draw_date),
      numbers_json: String(row.numbers)
    }));
    const tursoChanges = selectChangedDraws(draws, existingTurso);

    const tursoStatements = tursoChanges.map((draw) => ({
      sql: `
        INSERT INTO session_draws(game,session,draw_date,numbers,source_file,source_hash,imported_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(game,session,draw_date) DO UPDATE SET
          numbers=excluded.numbers,
          source_file=excluded.source_file,
          source_hash=excluded.source_hash,
          imported_at=excluded.imported_at
      `,
      args: [
        source.game,
        source.session,
        draw.drawDate,
        JSON.stringify(draw.numbers),
        source.filename,
        record.sha256,
        importedAt
      ]
    }));
    for (let i = 0; i < tursoStatements.length; i += 500) {
      await turso.batch(tursoStatements.slice(i, i + 500), "write");
    }
    tursoImported = tursoChanges.length;
    tursoUnchanged = draws.length - tursoChanges.length;
  }

  return {
    filename: source.filename,
    parsed: draws.length,
    imported: d1Changes.length,
    unchanged: draws.length - d1Changes.length,
    tursoImported,
    tursoUnchanged
  };
}

async function ingest(env: Env): Promise<{
  updated: number;
  unchanged: number;
  checked: number;
  skipped: boolean;
  errors: string[];
}> {
  type ChangedSource = {
    source: Source;
    text: string;
    bytes: Uint8Array;
    hash: string;
    lastModified: string | null;
    etag: string | null;
  };

  // Phase 1: check every CSV before creating an ingestion run or writing data.
  // A byte-identical source is a strict no-op: no archive upload, no drawing
  // writes, no source pointer update, and no ingestion_runs insert/update.
  const changedSources: ChangedSource[] = [];
  const errors: string[] = [];
  let unchanged = 0;
  let checked = 0;

  for (const source of TX) {
    try {
      const response = await fetch(source.url, {
        headers: { "user-agent": "BatchmateDataCollector/1.0 (historical lottery data)" },
        signal: AbortSignal.timeout(55000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text.trim() || /^\s*<(?:!doctype\s+html|html)/i.test(text)) {
        throw new Error("Empty response or HTML returned instead of CSV");
      }
      if (!text.includes("\n") || !text.includes(",")) throw new Error("Response does not look like CSV");

      const bytes = new TextEncoder().encode(text);
      const hash = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      const prior = await env.DB.prepare("SELECT sha256 FROM source_files WHERE filename=?")
        .bind(source.filename).first<{ sha256: string }>();
      checked++;

      if (isSourceHashUnchanged(prior?.sha256, hash)) {
        unchanged++;
        continue;
      }

      changedSources.push({
        source,
        text,
        bytes,
        hash,
        lastModified: response.headers.get("last-modified"),
        etag: response.headers.get("etag")
      });
    } catch (error) {
      errors.push(`${source.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Do not spend even the two ingestion_runs writes when all available
  // sources are identical. Log a run only when there is actual work or an error.
  if (changedSources.length === 0 && errors.length === 0) {
    console.log(`CSV check complete: ${checked} checked, ${unchanged} unchanged; ingestion skipped with zero D1 writes.`);
    return { updated: 0, unchanged, checked, skipped: true, errors };
  }

  const started = new Date().toISOString();
  const run = await env.DB.prepare(
    "INSERT INTO ingestion_runs(started_at,status,files_expected) VALUES(?,?,?)"
  ).bind(started, "running", TX.length).run();
  const runId = Number(run.meta.last_row_id);
  let updated = 0;

  for (const candidate of changedSources) {
    const { source, text, bytes, hash, lastModified, etag } = candidate;
    try {
      const key = `sources/${source.filename}/${hash}.csv`;
      await env.ARCHIVE.put(key, bytes, {
        httpMetadata: { contentType: "text/csv; charset=utf-8" },
        customMetadata: { game: source.game, session: source.session, sha256: hash }
      });

      // Persist only new or corrected draw dates in D1/Turso. Advance the
      // source hash pointer only after all required writes have succeeded.
      await reindexSource(env, source, { r2_key: key, sha256: hash });

      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO source_files(filename,source_url,sha256,bytes,row_count,fetched_at,last_modified,etag,r2_key)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(filename) DO UPDATE SET
          source_url=excluded.source_url, sha256=excluded.sha256, bytes=excluded.bytes,
          row_count=excluded.row_count, fetched_at=excluded.fetched_at,
          last_modified=excluded.last_modified, etag=excluded.etag, r2_key=excluded.r2_key
      `).bind(source.filename, source.url, hash, bytes.byteLength, csvRowCount(text),
        now, lastModified, etag, key).run();
      updated++;
    } catch (error) {
      errors.push(`${source.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const status = errors.length === 0 ? "success" : updated + unchanged > 0 ? "partial" : "failed";
  await env.DB.prepare(
    "UPDATE ingestion_runs SET finished_at=?,status=?,files_updated=?,error=? WHERE id=?"
  ).bind(new Date().toISOString(), status, updated, errors.join("\n") || null, runId).run();

  if (errors.length) throw new Error(`Ingestion ${status}: ${errors.join("; ")}`);
  return { updated, unchanged, checked, skipped: false, errors };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === "/health") return json({ ok: true, service: "batchmate-data", time: new Date().toISOString() });

    if (url.pathname === "/api/turso/health") {
      try {
        await checkTurso(env);
        return json({ ok: true, database: "turso", connected: true });
      } catch (error) {
        return json({
          ok: false,
          database: "turso",
          connected: false,
          error: error instanceof Error ? error.message : "Connection failed"
        }, 503);
      }
    }

    // Unified all-game read API. These routes read only from Turso's
    // lottery_draws table; they remain unused by the public frontend until
    // the full-history migration has been verified and cutover is approved.
    if (url.pathname === "/api/primary/analysis") {
      try {
        const db = getTursoClient(env);
        const result = await db.execute(
          "SELECT artifact_key,payload_json,payload_sha256,generated_at,payload_bytes,imported_at " +
          "FROM analysis_artifacts WHERE artifact_key IN ('batchmate_data','tight_tickets') " +
          "ORDER BY artifact_key,generated_at DESC"
        );
        const artifacts = new Map();
        for (const row of result.rows) {
          const key = String(row.artifact_key);
          if (!artifacts.has(key)) artifacts.set(key, row);
        }
        const batchmateRow = artifacts.get("batchmate_data");
        const tightRow = artifacts.get("tight_tickets");
        if (!batchmateRow || !tightRow) {
          return json({
            ok: false,
            storage: "turso-primary",
            error: "The latest Batchmate analysis snapshots have not been imported yet."
          }, 503);
        }

        const batchmateText = String(batchmateRow.payload_json);
        const tightText = String(tightRow.payload_json);
        const batchmateBytes = new TextEncoder().encode(batchmateText);
        const tightBytes = new TextEncoder().encode(tightText);
        const batchmateHash = await sha256Hex(
          batchmateBytes.buffer.slice(batchmateBytes.byteOffset, batchmateBytes.byteOffset + batchmateBytes.byteLength) as ArrayBuffer
        );
        const tightHash = await sha256Hex(
          tightBytes.buffer.slice(tightBytes.byteOffset, tightBytes.byteOffset + tightBytes.byteLength) as ArrayBuffer
        );
        if (batchmateHash !== String(batchmateRow.payload_sha256) ||
            tightHash !== String(tightRow.payload_sha256)) {
          return json({
            ok: false,
            storage: "turso-primary",
            error: "The stored analysis snapshots failed their integrity check."
          }, 503);
        }

        const batchmateData = JSON.parse(batchmateText);
        const tightTickets = JSON.parse(tightText);
        if (!batchmateData || !Array.isArray(batchmateData.games) ||
            !tightTickets || !Array.isArray(tightTickets.tickets) ||
            !Array.isArray(tightTickets.latest_draws)) {
          return json({
            ok: false,
            storage: "turso-primary",
            error: "The stored analysis snapshots do not match the expected data format."
          }, 503);
        }

        return json({
          ok: true,
          storage: "turso-primary",
          artifacts: {
            batchmate_data: {
              generated_at: String(batchmateRow.generated_at),
              sha256: batchmateHash,
              bytes: Number(batchmateRow.payload_bytes)
            },
            tight_tickets: {
              generated_at: String(tightRow.generated_at),
              sha256: tightHash,
              bytes: Number(tightRow.payload_bytes)
            }
          },
          batchmate_data: batchmateData,
          tight_tickets: tightTickets
        });
      } catch (error) {
        return json({
          ok: false,
          storage: "turso-primary",
          error: error instanceof Error ? error.message : "Analysis snapshots are unavailable"
        }, 503);
      }
    }

    if (url.pathname === "/api/primary/draws/summary") {
      try {
        const db = getTursoClient(env);
        const result = await db.execute(`
          SELECT game, session, COUNT(*) AS draw_count,
                 MIN(draw_date) AS first_draw_date,
                 MAX(draw_date) AS last_draw_date
          FROM lottery_draws
          GROUP BY game, session
          ORDER BY game, session
        `);
        const streams = result.rows.map((row) => ({
          game: String(row.game),
          session: String(row.session),
          draw_count: Number(row.draw_count),
          first_draw_date: String(row.first_draw_date),
          last_draw_date: String(row.last_draw_date)
        }));
        return json({
          ok: true,
          storage: "turso-primary",
          streamCount: streams.length,
          drawCount: streams.reduce((sum, stream) => sum + stream.draw_count, 0),
          streams
        });
      } catch (error) {
        return json({
          ok: false,
          storage: "turso-primary",
          error: error instanceof Error ? error.message : "Primary history summary unavailable"
        }, 503);
      }
    }

    if (url.pathname === "/api/primary/draws/latest") {
      try {
        const db = getTursoClient(env);
        const result = await db.execute(`
          SELECT d.source_filename, d.game, d.session, d.draw_date, d.numbers_json
          FROM lottery_draws d
          INNER JOIN (
            SELECT source_filename, MAX(draw_date) AS max_date
            FROM lottery_draws
            GROUP BY source_filename
          ) latest
            ON latest.source_filename=d.source_filename
           AND latest.max_date=d.draw_date
          ORDER BY d.game, d.session, d.draw_date DESC
        `);
        const draws = result.rows.map((row) => ({
          source_filename: String(row.source_filename),
          game: String(row.game),
          session: String(row.session),
          draw_date: String(row.draw_date),
          numbers_json: String(row.numbers_json)
        }));
        return json({ ok: true, storage: "turso-primary", count: draws.length, draws });
      } catch (error) {
        return json({
          ok: false,
          storage: "turso-primary",
          error: error instanceof Error ? error.message : "Primary latest drawings unavailable"
        }, 503);
      }
    }

    if (url.pathname === "/api/primary/draws") {
      const game = url.searchParams.get("game");
      const session = url.searchParams.get("session");
      const sourceFilename = url.searchParams.get("source");
      const before = url.searchParams.get("before");
      const allowedGames = new Set(TX.map((source) => source.game));
      const validSources = new Map(TX.map((source) => [
        source.filename,
        { game: source.game, session: source.session }
      ]));

      if (game && !allowedGames.has(game)) {
        return json({ error: "Unsupported game." }, 400);
      }
      if (sourceFilename && !validSources.has(sourceFilename)) {
        return json({ error: "Unsupported source file." }, 400);
      }
      if (session && !TX.some((source) => source.session === session && (!game || source.game === game))) {
        return json({ error: "Unsupported session for this game." }, 400);
      }
      if (sourceFilename) {
        const source = validSources.get(sourceFilename)!;
        if ((game && source.game !== game) || (session && source.session !== session)) {
          return json({ error: "Source file does not match the requested game/session." }, 400);
        }
      }
      const beforeSource = url.searchParams.get("beforeSource");
      if (before) {
        const dateValue = new Date(before + "T00:00:00.000Z");
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(before) &&
          Number.isFinite(dateValue.getTime()) &&
          dateValue.toISOString().slice(0, 10) === before;
        if (!validDate) return json({ error: "before must be a real YYYY-MM-DD date." }, 400);
      }
      if (beforeSource && !validSources.has(beforeSource)) {
        return json({ error: "beforeSource must be a supported source filename." }, 400);
      }
      if (beforeSource && !before) {
        return json({ error: "beforeSource requires before." }, 400);
      }

      const parsedLimit = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(parsedLimit) ? Math.min(500, Math.max(1, Math.trunc(parsedLimit))) : 100;
      const clauses: string[] = [];
      const args: (string | number)[] = [];
      if (game) { clauses.push("game=?"); args.push(game); }
      if (session) { clauses.push("session=?"); args.push(session); }
      if (sourceFilename) { clauses.push("source_filename=?"); args.push(sourceFilename); }
      if (before && beforeSource) {
        clauses.push("(draw_date<? OR (draw_date=? AND source_filename>?))");
        args.push(before, before, beforeSource);
      } else if (before) {
        clauses.push("draw_date<?");
        args.push(before);
      }

      try {
        const db = getTursoClient(env);
        const result = await db.execute({
          sql: `SELECT source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at
                FROM lottery_draws
                ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
                ORDER BY draw_date DESC,source_filename ASC
                LIMIT ?`,
          args: [...args, limit]
        });
        const draws = result.rows.map((row) => ({
          source_filename: String(row.source_filename),
          game: String(row.game),
          session: String(row.session),
          draw_date: String(row.draw_date),
          numbers_json: String(row.numbers_json),
          source_sha256: String(row.source_sha256),
          imported_at: String(row.imported_at)
        }));
        return json({
          ok: true,
          storage: "turso-primary",
          count: draws.length,
          draws,
          nextBefore: draws.length === limit ? draws[draws.length - 1].draw_date : null,
          nextBeforeSource: draws.length === limit ? draws[draws.length - 1].source_filename : null
        });
      } catch (error) {
        return json({
          ok: false,
          storage: "turso-primary",
          error: error instanceof Error ? error.message : "Primary drawing history unavailable"
        }, 503);
      }
    }

    if (url.pathname === "/api/session-draws/summary") {
      try {
        const db = getTursoClient(env);
        const result = await db.execute(`
          SELECT game, session, COUNT(*) AS draw_count,
                 MIN(draw_date) AS first_draw_date,
                 MAX(draw_date) AS last_draw_date
          FROM session_draws
          GROUP BY game, session
          ORDER BY game, CASE session
            WHEN 'morning' THEN 1 WHEN 'day' THEN 2
            WHEN 'evening' THEN 3 WHEN 'night' THEN 4 ELSE 5 END
        `);
        const streams = result.rows.map((row) => ({
          game: String(row.game),
          session: String(row.session),
          draw_count: Number(row.draw_count),
          first_draw_date: String(row.first_draw_date),
          last_draw_date: String(row.last_draw_date)
        }));
        return json({
          ok: true,
          storage: "turso",
          streamCount: streams.length,
          drawCount: streams.reduce((sum, stream) => sum + stream.draw_count, 0),
          streams
        });
      } catch (error) {
        return json({ ok: false, storage: "turso", error: error instanceof Error ? error.message : "History query failed" }, 503);
      }
    }

    if (url.pathname === "/api/session-draws") {
      const game = url.searchParams.get("game") || "";
      const session = url.searchParams.get("session") || "";
      const after = url.searchParams.get("after");
      const allowedGames = ["All or Nothing", "Pick 3", "Daily 4"];
      const allowedSessions = ["morning", "day", "evening", "night"];
      if (!allowedGames.includes(game) || !allowedSessions.includes(session)) {
        return json({ error: "Supply a supported game and session." }, 400);
      }
      if (after && !/^\d{4}-\d{2}-\d{2}$/.test(after)) {
        return json({ error: "after must be YYYY-MM-DD." }, 400);
      }
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 500)));
      try {
        const db = getTursoClient(env);
        const result = await db.execute({
          sql: `SELECT game, session, draw_date, numbers, source_file, source_hash, imported_at
                FROM session_draws
                WHERE game=? AND session=? ${after ? "AND draw_date>?" : ""}
                ORDER BY draw_date ASC LIMIT ?`,
          args: after ? [game, session, after, limit] : [game, session, limit]
        });
        const draws = result.rows.map((row) => ({
          game: String(row.game),
          session: String(row.session),
          draw_date: String(row.draw_date),
          numbers: String(row.numbers),
          source_file: String(row.source_file),
          source_hash: String(row.source_hash),
          imported_at: String(row.imported_at)
        }));
        return json({
          ok: true,
          storage: "turso",
          game,
          session,
          count: draws.length,
          draws,
          nextAfter: draws.length === limit ? draws[draws.length - 1].draw_date : null
        });
      } catch (error) {
        return json({ ok: false, storage: "turso", error: error instanceof Error ? error.message : "History query failed" }, 503);
      }
    }

    // Read-only D1 export endpoints used only during the Turso migration.
    // They do not write to D1 and are not the public application data API.
    if (url.pathname === "/api/migration/source-files") {
      const migrationToken = request.headers.get("authorization");
      if (!env.API_TOKEN || migrationToken !== `Bearer ${env.API_TOKEN}`) {
        return json({ error: "Unauthorized" }, 401);
      }

      try {
        const result = await env.DB.prepare(`
          SELECT filename,source_url,sha256,bytes,row_count,fetched_at,
                 last_modified,etag,r2_key
          FROM source_files
          ORDER BY filename
        `).all();
        return json({
          ok: true,
          storage: "cloudflare-d1-migration-source",
          count: result.results.length,
          sources: result.results
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Source metadata export failed"
        }, 503);
      }
    }

    if (url.pathname === "/api/migration/ingestion-runs") {
      const migrationToken = request.headers.get("authorization");
      if (!env.API_TOKEN || migrationToken !== `Bearer ${env.API_TOKEN}`) {
        return json({ error: "Unauthorized" }, 401);
      }

      const beforeValue = url.searchParams.get("before");
      const before = beforeValue === null ? 0 : Number(beforeValue);
      if (beforeValue !== null && (!Number.isSafeInteger(before) || before <= 0)) {
        return json({ error: "before must be a positive ingestion run ID." }, 400);
      }
      const requestedLimit = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(200, Math.max(1, Math.trunc(requestedLimit)))
        : 100;
      try {
        const result = beforeValue === null
          ? await env.DB.prepare(`
              SELECT id,started_at,finished_at,status,files_expected,files_updated,error
              FROM ingestion_runs
              ORDER BY id DESC
              LIMIT ?
            `).bind(limit).all()
          : await env.DB.prepare(`
              SELECT id,started_at,finished_at,status,files_expected,files_updated,error
              FROM ingestion_runs
              WHERE id < ?
              ORDER BY id DESC
              LIMIT ?
            `).bind(before, limit).all();
        const runs = result.results;
        return json({
          ok: true,
          storage: "cloudflare-d1-migration-source",
          count: runs.length,
          runs,
          nextBefore: runs.length === limit ? Number(runs[runs.length - 1].id) : null
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Ingestion metadata export failed"
        }, 503);
      }
    }

    if (url.pathname === "/api/status") {
      const [run, files] = await Promise.all([
        env.DB.prepare("SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1").first(),
        env.DB.prepare("SELECT filename,sha256,bytes,row_count,fetched_at,r2_key FROM source_files ORDER BY filename").all()
      ]);
      return json({ latestRun: run, sourceCount: files.results.length, expectedSourceCount: TX.length, sources: files.results });
    }

    if (url.pathname.startsWith("/api/sources/")) {
      const filename = decodeURIComponent(url.pathname.slice("/api/sources/".length));
      if (!TX.some((s) => s.filename === filename)) return json({ error: "Unknown source file" }, 404);
      const record = await env.DB.prepare("SELECT r2_key FROM source_files WHERE filename=?").bind(filename).first<{ r2_key: string }>();
      if (!record) return json({ error: "Source has not been collected yet" }, 404);
      const object = await env.ARCHIVE.get(record.r2_key);
      if (!object) return json({ error: "Source has not been collected yet" }, 404);
      return new Response(object.body, {
        headers: { ...CORS_HEADERS, "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=300", etag: object.httpEtag }
      });
    }

    if (url.pathname === "/api/draws/latest") {
      const result = await env.DB.prepare(`
        SELECT d.source_filename,d.game,d.session,d.draw_date,d.numbers_json
        FROM draws d
        INNER JOIN (
          SELECT source_filename,MAX(draw_date) AS max_date FROM draws GROUP BY source_filename
        ) latest ON latest.source_filename=d.source_filename AND latest.max_date=d.draw_date
        ORDER BY
          CASE d.game
            WHEN 'All or Nothing' THEN 1
            WHEN 'Pick 3' THEN 2
            WHEN 'Daily 4' THEN 3
            WHEN 'Cash Five' THEN 4
            WHEN 'Texas Two Step' THEN 5
            WHEN 'Lotto Texas' THEN 6
            WHEN 'Powerball' THEN 7
            WHEN 'Mega Millions' THEN 8
            ELSE 99
          END,
          CASE d.session
            WHEN 'morning' THEN 1
            WHEN 'day' THEN 2
            WHEN 'evening' THEN 3
            WHEN 'night' THEN 4
            ELSE 5
          END,
          d.draw_date DESC
      `).all();
      return json({ count: result.results.length, draws: result.results });
    }

    if (url.pathname === "/api/draws") {
      const game = url.searchParams.get("game");
      const session = url.searchParams.get("session");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const before = url.searchParams.get("before");
      let query = "SELECT source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at FROM draws WHERE 1=1";
      const values: (string | number)[] = [];
      if (game) { query += " AND game=?"; values.push(game); }
      if (session) { query += " AND session=?"; values.push(session); }
      if (before) { query += " AND draw_date<?"; values.push(before); }
      query += " ORDER BY draw_date DESC,source_filename LIMIT ?";
      values.push(Number.isFinite(limit) ? limit : 100);
      const result = await env.DB.prepare(query).bind(...values).all();
      return json({ count: result.results.length, draws: result.results });
    }

    if (url.pathname === "/api/admin/reindex" && request.method === "POST") {
      const token = request.headers.get("authorization");
      if (!env.API_TOKEN || token !== `Bearer ${env.API_TOKEN}`) return json({ error: "Unauthorized" }, 401);
      const filename = url.searchParams.get("file");
      const source = TX.find((s) => s.filename === filename);
      if (!source) return json({ error: "Supply one valid source filename using ?file=" + TX.map((s) => s.filename).join(",") }, 400);
      try { return json({ ok: true, ...(await reindexSource(env, source)) }); }
      catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502); }
    }

    if (url.pathname === "/api/admin/ingest" && request.method === "POST") {
      const token = request.headers.get("authorization");
      if (!env.API_TOKEN || token !== `Bearer ${env.API_TOKEN}`) return json({ error: "Unauthorized" }, 401);
      try { return json({ ok: true, ...(await ingest(env)) }); }
      catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502); }
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.INGEST_PAUSED === "true") {
      console.log("Scheduled ingestion is paused; skipping D1 and Turso writes.");
      return;
    }
    await ingest(env);
  }
};
