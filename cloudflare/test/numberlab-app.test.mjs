import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDrawNumbers,
  formatDraw,
  compareDraws,
  summarizeFrequency,
  hasCompletePrimaryHistory,
  sortDrawsChronologically
} from "../../numberlab-app.mjs";

const required = [
  ["All or Nothing", "morning"], ["All or Nothing", "day"], ["All or Nothing", "evening"], ["All or Nothing", "night"],
  ["Pick 3", "morning"], ["Pick 3", "day"], ["Pick 3", "evening"], ["Pick 3", "night"],
  ["Daily 4", "morning"], ["Daily 4", "day"], ["Daily 4", "evening"], ["Daily 4", "night"],
  ["Cash Five", "daily"], ["Texas Two Step", "draw"], ["Lotto Texas", "draw"], ["Powerball", "draw"], ["Mega Millions", "draw"]
];

test("parses the canonical Turso number payload", () => {
  assert.deepEqual(parseDrawNumbers({ numbers_json: "[0,4,7]" }), [0, 4, 7]);
});

test("parses the legacy session API payload", () => {
  assert.deepEqual(parseDrawNumbers({ numbers: "[2, 5, 9]" }), [2, 5, 9]);
});

test("preserves leading zeroes when formatting digit-game results", () => {
  assert.equal(formatDraw({ game: "Pick 3", numbers_json: "[0,4,7]" }), "047");
  assert.equal(formatDraw({ game: "Daily 4", numbers_json: "[0,0,2,8]" }), "0028");
});

test("compares Pick 3 and Daily 4 by position", () => {
  assert.deepEqual(
    compareDraws(
      { game: "Pick 3", numbers_json: "[1,2,3]" },
      { game: "Pick 3", numbers_json: "[1,9,3]" }
    ).changedPositions,
    [{ position: 2, from: 2, to: 9 }]
  );
});

test("compares number games by shared, added, and removed values", () => {
  assert.deepEqual(
    compareDraws(
      { game: "Cash Five", numbers_json: "[1,2,3,4,5]" },
      { game: "Cash Five", numbers_json: "[2,3,4,5,6]" }
    ),
    { changedPositions: [], shared: [2,3,4,5], added: [6], removed: [1] }
  );
});

test("summarizes observed number frequencies across results", () => {
  assert.deepEqual(
    summarizeFrequency([
      { numbers_json: "[1,2,2]" },
      { numbers_json: "[2,3]" }
    ]).map(({ number, count }) => ({ number, count })),
    [{ number: 2, count: 3 }, { number: 1, count: 1 }, { number: 3, count: 1 }]
  );
});

test("requires all 17 source streams before calling the primary history complete", () => {
  const streams = required.map(([game, session]) => ({ game, session, draw_count: 1 }));
  assert.equal(hasCompletePrimaryHistory({ ok: true, streamCount: 17, streams }), true);
  assert.equal(hasCompletePrimaryHistory({ ok: true, streamCount: 16, streams: streams.slice(0, 16) }), false);
  assert.equal(hasCompletePrimaryHistory({ ok: true, streamCount: 17, streams: streams.slice(1) }), false);
  assert.equal(hasCompletePrimaryHistory({ ok: true, streamCount: 17, streams: streams.map((item, i) => i ? item : ({ ...item, draw_count: 0 })) }), false);
});

test("sorts all-game drawing rows chronologically and deterministically", () => {
  const sorted = sortDrawsChronologically([
    { draw_date: "2026-11-20", source_filename: "a.csv" },
    { draw_date: "2026-11-18", source_filename: "b.csv" },
    { draw_date: "2026-11-20", source_filename: "b.csv" }
  ]);
  assert.deepEqual(sorted.map((row) => row.draw_date + "|" + row.source_filename), [
    "2026-11-18|b.csv",
    "2026-11-20|a.csv",
    "2026-11-20|b.csv"
  ]);
});
