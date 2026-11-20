const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const buildDir = process.env.INGESTION_BUILD_DIR;
if (!buildDir) throw new Error("INGESTION_BUILD_DIR is required");

const { isSourceHashUnchanged, selectChangedDraws } = require(
  path.join(buildDir, "ingestion", "delta.js")
);

const oldDraw = {
  drawDate: "2026-11-18",
  numbers: [1, 2, 3]
};

test("identical source data produces no draw writes", () => {
  const changed = selectChangedDraws(
    [oldDraw],
    [{ draw_date: "2026-11-18", numbers_json: "[1,2,3]", game: "Pick 3", session: "morning" }],
    { game: "Pick 3", session: "morning" }
  );
  assert.deepEqual(changed, []);
});

test("new draw date is selected for insertion", () => {
  const changed = selectChangedDraws(
    [oldDraw, { drawDate: "2026-11-19", numbers: [4, 5, 6] }],
    [{ draw_date: "2026-11-18", numbers_json: "[1,2,3]", game: "Pick 3", session: "morning" }],
    { game: "Pick 3", session: "morning" }
  );
  assert.deepEqual(changed, [{ drawDate: "2026-11-19", numbers: [4, 5, 6] }]);
});

test("corrected numbers for an existing draw date are selected", () => {
  const changed = selectChangedDraws(
    [{ drawDate: "2026-11-18", numbers: [1, 2, 9] }],
    [{ draw_date: "2026-11-18", numbers_json: "[1,2,3]" }]
  );
  assert.deepEqual(changed, [{ drawDate: "2026-11-18", numbers: [1, 2, 9] }]);
});

test("a metadata classification change is selected even when numbers match", () => {
  const changed = selectChangedDraws(
    [oldDraw],
    [{ draw_date: "2026-11-18", numbers_json: "[1,2,3]", game: "Pick 3", session: "day" }],
    { game: "Pick 3", session: "morning" }
  );
  assert.deepEqual(changed, [oldDraw]);
});

test("Turso comparison ignores archive hash changes when draw values match", () => {
  const changed = selectChangedDraws(
    [oldDraw],
    [{ draw_date: "2026-11-18", numbers_json: "[1,2,3]" }]
  );
  assert.deepEqual(changed, []);
});

test("byte-identical CSV hash is a strict no-op", () => {
  assert.equal(isSourceHashUnchanged("abc123", "abc123"), true);
  assert.equal(isSourceHashUnchanged("abc123", "def456"), false);
  assert.equal(isSourceHashUnchanged(undefined, "def456"), false);
});
