interface Env {
  DB: D1Database;
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
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
    if (url.pathname === "/health") return json({ ok: true, service: "batchmate-data", time: new Date().toISOString() });

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
        headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=300", etag: object.httpEtag }
      });
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
