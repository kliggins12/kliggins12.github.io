import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { ANALYSIS_ARTIFACTS, validateAnalysisArtifact } from "./lib/analysis-artifacts.mjs";

const DATABASE_URL = process.env.TURSO_DATABASE_URL;
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const APPLY = process.argv.includes("--apply");
const CONFIRMATION = process.env.CONFIRM_ANALYSIS_IMPORT;

if (!DATABASE_URL || !AUTH_TOKEN) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.");
}
if (APPLY && CONFIRMATION !== "IMPORT-ANALYSIS-ARTIFACTS") {
  throw new Error("Import blocked. Set CONFIRM_ANALYSIS_IMPORT=IMPORT-ANALYSIS-ARTIFACTS and pass --apply.");
}
if (process.argv.some((arg) => arg.startsWith("--") && arg !== "--apply")) {
  throw new Error("Only --apply is supported. Without it, this script performs a read-only report.");
}

async function readArtifacts() {
  const artifacts = [];
  for (const source of ANALYSIS_ARTIFACTS) {
    const response = await fetch(source.url, {
      headers: { accept: "application/json", "user-agent": "BatchmateArtifactMigration/1.0" },
      signal: AbortSignal.timeout(55000)
    });
    if (!response.ok) throw new Error("Could not download " + source.key + ": HTTP " + response.status + ".");
    const raw = await response.text();
    if (!raw || raw.length > 12 * 1024 * 1024) {
      throw new Error(source.key + " is empty or exceeds the 12 MB artifact safety limit.");
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error(source.key + " is not valid JSON."); }
    const summary = validateAnalysisArtifact(source.key, payload);
    const payloadBytes = new TextEncoder().encode(raw).byteLength;
    const payloadSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    artifacts.push({
      artifact_key: source.key,
      generated_at: summary.generatedAt,
      payload_json: raw,
      payload_sha256: payloadSha256,
      payload_bytes: payloadBytes,
      imported_at: new Date().toISOString(),
      item_count: summary.itemCount,
      detail_count: summary.detailCount
    });
  }
  return artifacts;
}

async function readLatestArtifactRows(db) {
  const result = await db.execute(
    "SELECT artifact_key,generated_at,payload_sha256,payload_bytes " +
    "FROM analysis_artifacts ORDER BY artifact_key,generated_at DESC"
  );
  const latest = new Map();
  for (const row of result.rows) {
    const key = String(row.artifact_key);
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

async function main() {
  const db = createClient({ url: DATABASE_URL, authToken: AUTH_TOKEN });
  const report = {
    run_id: randomUUID(),
    generated_at: new Date().toISOString(),
    mode: APPLY ? "apply" : "read-only report",
    status: "FAIL",
    artifacts: [],
    errors: []
  };
  try {
    await db.execute("SELECT artifact_key FROM analysis_artifacts LIMIT 0");
    const sourceArtifacts = await readArtifacts();
    const targetArtifacts = await readLatestArtifactRows(db);

    for (const source of sourceArtifacts) {
      const target = targetArtifacts.get(source.artifact_key);
      const matches = !!target &&
        String(target.generated_at) === source.generated_at &&
        String(target.payload_sha256) === source.payload_sha256 &&
        Number(target.payload_bytes) === source.payload_bytes;
      report.artifacts.push({
        artifact_key: source.artifact_key,
        generated_at: source.generated_at,
        payload_bytes: source.payload_bytes,
        item_count: source.item_count,
        detail_count: source.detail_count,
        target_generated_at: target ? String(target.generated_at) : null,
        target_sha256_matches: !!target && String(target.payload_sha256) === source.payload_sha256,
        matches
      });
    }

    if (!APPLY) {
      report.status = report.artifacts.every((item) => item.matches) ? "ALREADY_MATCHES" : "READY_FOR_REVIEW";
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.stdout.write("Read-only artifact report complete. No Turso rows were written.\n");
      return;
    }

    const sql = `INSERT INTO analysis_artifacts
      (artifact_key,generated_at,payload_json,payload_sha256,payload_bytes,imported_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(artifact_key,generated_at) DO UPDATE SET
        payload_json=excluded.payload_json,
        payload_sha256=excluded.payload_sha256,
        payload_bytes=excluded.payload_bytes,
        imported_at=excluded.imported_at
      WHERE analysis_artifacts.payload_sha256 IS NOT excluded.payload_sha256
         OR analysis_artifacts.payload_bytes IS NOT excluded.payload_bytes`;
    await db.batch(sourceArtifacts.map((artifact) => ({
      sql,
      args: [
        artifact.artifact_key,
        artifact.generated_at,
        artifact.payload_json,
        artifact.payload_sha256,
        artifact.payload_bytes,
        artifact.imported_at
      ]
    })), "write");

    for (const source of sourceArtifacts) {
      const verified = await db.execute({
        sql: "SELECT payload_json,payload_sha256,payload_bytes FROM analysis_artifacts WHERE artifact_key=? AND generated_at=?",
        args: [source.artifact_key, source.generated_at]
      });
      if (verified.rows.length !== 1) {
        throw new Error("Missing imported analysis artifact: " + source.artifact_key + ".");
      }
      const row = verified.rows[0];
      const raw = String(row.payload_json);
      const actualHash = createHash("sha256").update(raw, "utf8").digest("hex");
      if (actualHash !== source.payload_sha256 ||
          String(row.payload_sha256) !== source.payload_sha256 ||
          Number(row.payload_bytes) !== source.payload_bytes) {
        throw new Error("Exact payload verification failed for " + source.artifact_key + ".");
      }
    }

    report.status = "SUCCESS";
    report.artifacts.forEach((artifact) => { artifact.verified = true; });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.status = "FAIL";
    process.stderr.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

await main();
