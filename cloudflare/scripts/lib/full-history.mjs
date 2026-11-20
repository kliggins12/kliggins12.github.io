export const MIGRATION_KEY = "primary-history-v1";

export const SOURCE_CATALOG = Object.freeze([
  ...["morning", "day", "evening", "night"].map((session) => ({
    filename: `aon_${session}.csv`,
    game: "All or Nothing",
    session
  })),
  ...["morning", "day", "evening", "night"].map((session) => ({
    filename: `pick3${session}.csv`,
    game: "Pick 3",
    session
  })),
  ...["morning", "day", "evening", "night"].map((session) => ({
    filename: `daily4${session}.csv`,
    game: "Daily 4",
    session
  })),
  { filename: "cashfive.csv", game: "Cash Five", session: "daily" },
  { filename: "texastwostep.csv", game: "Texas Two Step", session: "draw" },
  { filename: "lottotexas.csv", game: "Lotto Texas", session: "draw" },
  { filename: "powerball.csv", game: "Powerball", session: "draw" },
  { filename: "megamillions.csv", game: "Mega Millions", session: "draw" }
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const EXPECTED_NUMBER_COUNTS = Object.freeze({
  "All or Nothing": 12,
  "Pick 3": 3,
  "Daily 4": 4,
  "Cash Five": 5,
  "Texas Two Step": 5,
  "Lotto Texas": 6,
  "Powerball": 6,
  "Mega Millions": 6
});
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealIsoDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeDrawRow(row, source) {
  if (!row || typeof row !== "object") throw new Error("Drawing row is not an object.");

  const sourceFilename = String(row.source_filename ?? "");
  const game = String(row.game ?? "");
  const session = String(row.session ?? "");
  const drawDate = String(row.draw_date ?? "");
  const sourceSha256 = String(row.source_sha256 ?? "");
  const importedAt = String(row.imported_at ?? "");
  const numbersText = String(row.numbers_json ?? "");

  if (sourceFilename !== source.filename) {
    throw new Error(`Expected ${source.filename}; received ${sourceFilename || "no source filename"}.`);
  }
  if (game !== source.game || session !== source.session) {
    throw new Error(`Unexpected game/session for ${source.filename}: ${game} / ${session}.`);
  }
  if (!isRealIsoDate(drawDate)) {
    throw new Error(`Invalid draw date in ${source.filename}: ${drawDate}.`);
  }
  if (!SHA256_PATTERN.test(sourceSha256)) {
    throw new Error(`Invalid source SHA-256 in ${source.filename} for ${drawDate}.`);
  }
  if (!importedAt || !Number.isFinite(Date.parse(importedAt))) {
    throw new Error(`Invalid imported_at timestamp in ${source.filename} for ${drawDate}.`);
  }

  let numbers;
  try {
    numbers = JSON.parse(numbersText);
  } catch {
    throw new Error(`Invalid numbers_json in ${source.filename} for ${drawDate}.`);
  }
  if (!Array.isArray(numbers) || numbers.length !== EXPECTED_NUMBER_COUNTS[game] ||
      numbers.some((number) => !Number.isInteger(number) || number < 0)) {
    throw new Error(`Drawing numbers must contain exactly the expected count of non-negative integers in ${source.filename} for ${drawDate}.`);
  }

  return {
    source_filename: sourceFilename,
    game,
    session,
    draw_date: drawDate,
    numbers_json: JSON.stringify(numbers),
    source_sha256: sourceSha256.toLowerCase(),
    imported_at: importedAt
  };
}


export function normalizeSourceFile(row, source) {
  if (!row || typeof row !== "object") throw new Error("Source metadata row is not an object.");
  const filename = String(row.filename ?? "");
  const sourceUrl = String(row.source_url ?? "");
  const sha256 = String(row.sha256 ?? "").toLowerCase();
  const bytes = Number(row.bytes);
  const rowCount = Number(row.row_count);
  const fetchedAt = String(row.fetched_at ?? "");
  const lastModified = row.last_modified == null ? null : String(row.last_modified);
  const etag = row.etag == null ? null : String(row.etag);
  const r2Key = String(row.r2_key ?? "");

  if (filename !== source.filename) throw new Error(`Unexpected source metadata file: ${filename}.`);
  if (!sourceUrl.toLowerCase().startsWith("https://")) throw new Error(`Invalid source URL for ${filename}.`);
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid source hash for ${filename}.`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Invalid byte size for ${filename}.`);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) throw new Error(`Invalid CSV row count for ${filename}.`);
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) throw new Error(`Invalid fetch timestamp for ${filename}.`);
  if (!r2Key.startsWith(`sources/${filename}/`) || !r2Key.endsWith(".csv")) {
    throw new Error(`Invalid R2 archive key for ${filename}.`);
  }

  return {
    filename,
    source_url: sourceUrl,
    sha256,
    bytes,
    row_count: rowCount,
    fetched_at: fetchedAt,
    last_modified: lastModified,
    etag,
    r2_key: r2Key
  };
}

export function normalizeIngestionRun(row) {
  if (!row || typeof row !== "object") throw new Error("Ingestion run row is not an object.");
  const id = Number(row.id);
  const startedAt = String(row.started_at ?? "");
  const finishedAt = row.finished_at == null ? null : String(row.finished_at);
  const status = String(row.status ?? "");
  const filesExpected = Number(row.files_expected);
  const filesUpdated = Number(row.files_updated);
  const error = row.error == null ? null : String(row.error);

  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid ingestion run ID.");
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) throw new Error(`Invalid start timestamp for ingestion run ${id}.`);
  if (finishedAt !== null && !Number.isFinite(Date.parse(finishedAt))) throw new Error(`Invalid finish timestamp for ingestion run ${id}.`);
  if (!["running", "success", "partial", "failed"].includes(status)) throw new Error(`Invalid status for ingestion run ${id}.`);
  if (!Number.isSafeInteger(filesExpected) || filesExpected < 0) throw new Error(`Invalid expected-file count for ingestion run ${id}.`);
  if (!Number.isSafeInteger(filesUpdated) || filesUpdated < 0) throw new Error(`Invalid updated-file count for ingestion run ${id}.`);

  return {
    id,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    files_expected: filesExpected,
    files_updated: filesUpdated,
    error
  };
}
