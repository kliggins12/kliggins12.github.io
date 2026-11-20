import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_CATALOG, isRealIsoDate, normalizeDrawRow, normalizeSourceFile, normalizeIngestionRun } from "../scripts/lib/full-history.mjs";

const source = SOURCE_CATALOG.find((item) => item.filename === "pick3morning.csv");
const validRow = {
  source_filename: "pick3morning.csv",
  game: "Pick 3",
  session: "morning",
  draw_date: "2026-11-19",
  numbers_json: "[2,4,1]",
  source_sha256: "a".repeat(64),
  imported_at: "2026-11-20T05:00:00.000Z"
};

test("catalog contains all 17 source files exactly once", () => {
  assert.equal(SOURCE_CATALOG.length, 17);
  assert.equal(new Set(SOURCE_CATALOG.map((item) => item.filename)).size, 17);
});

test("catalog includes the eight game families and all 12 sessioned feeds", () => {
  const sessioned = SOURCE_CATALOG.filter((item) =>
    ["morning", "day", "evening", "night"].includes(item.session)
  );
  assert.equal(sessioned.length, 12);
  assert.deepEqual(
    new Set(SOURCE_CATALOG.map((item) => item.game)),
    new Set(["All or Nothing", "Pick 3", "Daily 4", "Cash Five", "Texas Two Step", "Lotto Texas", "Powerball", "Mega Millions"])
  );
});

test("ISO dates are checked as real calendar dates", () => {
  assert.equal(isRealIsoDate("2024-02-29"), true);
  assert.equal(isRealIsoDate("2025-02-29"), false);
  assert.equal(isRealIsoDate("2026-13-01"), false);
});

test("normalizes a valid source draw without changing its numeric order", () => {
  assert.deepEqual(normalizeDrawRow(validRow, source), {
    ...validRow,
    numbers_json: "[2,4,1]",
    source_sha256: "a".repeat(64)
  });
});

test("rejects a row assigned to a different source file", () => {
  assert.throws(
    () => normalizeDrawRow({ ...validRow, source_filename: "pick3night.csv" }, source),
    /Expected pick3morning\.csv/
  );
});

test("rejects wrong game/session classification", () => {
  assert.throws(
    () => normalizeDrawRow({ ...validRow, session: "night" }, source),
    /Unexpected game\/session/
  );
});

test("rejects invalid numbers payloads", () => {
  assert.throws(
    () => normalizeDrawRow({ ...validRow, numbers_json: "[1, \"3\"]" }, source),
    /non-negative integers/
  );
});

test("rejects a draw with the wrong number count for its game", () => {
  assert.throws(
    () => normalizeDrawRow({ ...validRow, numbers_json: "[2,4]" }, source),
    /expected count/
  );
});


test("normalizes source-file metadata without losing archive provenance", () => {
  const source = SOURCE_CATALOG[0];
  const row = normalizeSourceFile({
    filename: source.filename,
    source_url: "https://example.com/source.csv",
    sha256: "b".repeat(64),
    bytes: 1200,
    row_count: 100,
    fetched_at: "2026-11-20T05:00:00.000Z",
    last_modified: null,
    etag: "etag-value",
    r2_key: `sources/${source.filename}/${"b".repeat(64)}.csv`
  }, source);
  assert.equal(row.filename, source.filename);
  assert.equal(row.sha256, "b".repeat(64));
  assert.equal(row.etag, "etag-value");
});

test("rejects source metadata with a mismatched archive key", () => {
  const source = SOURCE_CATALOG[0];
  assert.throws(() => normalizeSourceFile({
    filename: source.filename,
    source_url: "https://example.com/source.csv",
    sha256: "b".repeat(64),
    bytes: 1200,
    row_count: 100,
    fetched_at: "2026-11-20T05:00:00.000Z",
    r2_key: "wrong/path.csv"
  }, source), /Invalid R2 archive key/);
});

test("normalizes full ingestion-run history with nullable completion fields", () => {
  assert.deepEqual(normalizeIngestionRun({
    id: 9,
    started_at: "2026-11-20T05:00:00.000Z",
    finished_at: null,
    status: "running",
    files_expected: 17,
    files_updated: 0,
    error: null
  }), {
    id: 9,
    started_at: "2026-11-20T05:00:00.000Z",
    finished_at: null,
    status: "running",
    files_expected: 17,
    files_updated: 0,
    error: null
  });
});
