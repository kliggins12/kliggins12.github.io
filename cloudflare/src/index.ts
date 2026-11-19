import { checkTurso } from "./turso";

interface Env {
  DB: D1Database;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  ARCHIVE: R2Bucket;
  API_TOKEN?: string;
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

async function reindexSource(env: Env, source: Source): Promise<{ filename: string; imported: number }> {
  const record = await env.DB.prepare("SELECT r2_key,sha256 FROM source_files WHERE filename=?")
    .bind(source.filename).first<{ r2_key: string; sha256: string }>();
  if (!record) throw new Error(`No archived source found for ${source.filename}`);
  const object = await env.ARCHIVE.get(record.r2_key);
  if (!object) throw new Error(`Archived CSV is missing for ${source.filename}`);
  const csv = await object.text();
  const draws = parseSourceDraws(csv, source);
  if (draws.length === 0) throw new Error(`No valid draw rows parsed from ${source.filename}; existing history was left unchanged`);

  const importedAt = new Date().toISOString();
  const statements = draws.map((draw) => env.DB.prepare(`
    INSERT INTO draws(source_filename,game,session,draw_date,numbers_json,source_sha256,imported_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(source_filename,draw_date) DO UPDATE SET
      game=excluded.game, session=excluded.session, numbers_json=excluded.numbers_json,
      source_sha256=excluded.source_sha256, imported_at=excluded.imported_at
  `).bind(source.filename, source.game, source.session, draw.drawDate,
    JSON.stringify(draw.numbers), record.sha256, importedAt));

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return { filename: source.filename, imported: draws.length };
}

async function ingest(env: Env): Promise<{ updated: number; unchanged: number; errors: string[] }> {
  const started = new Date().toISOString();
  const run = await env.DB.prepare(
    "INSERT INTO ingestion_runs(started_at,status,files_expected) VALUES(?,?,?)"
  ).bind(started, "running", TX.length).run();
  const runId = Number(run.meta.last_row_id);
  let updated = 0, unchanged = 0;
  const errors: string[] = [];

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
      if (prior?.sha256 === hash) { unchanged++; continue; }

      const key = `sources/${source.filename}/${hash}.csv`;
      await env.ARCHIVE.put(key, bytes, {
        httpMetadata: { contentType: "text/csv; charset=utf-8" },
        customMetadata: { game: source.game, session: source.session, sha256: hash }
      });
      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO source_files(filename,source_url,sha256,bytes,row_count,fetched_at,last_modified,etag,r2_key)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(filename) DO UPDATE SET
          source_url=excluded.source_url, sha256=excluded.sha256, bytes=excluded.bytes,
          row_count=excluded.row_count, fetched_at=excluded.fetched_at,
          last_modified=excluded.last_modified, etag=excluded.etag, r2_key=excluded.r2_key
      `).bind(source.filename, source.url, hash, bytes.byteLength, csvRowCount(text),
        now, response.headers.get("last-modified"), response.headers.get("etag"), key).run();
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
  return { updated, unchanged, errors };
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
    await ingest(env);
  }
};
