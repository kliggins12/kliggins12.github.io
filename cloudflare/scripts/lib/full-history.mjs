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
  if (!Array.isArray(numbers) || numbers.length === 0 ||
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
