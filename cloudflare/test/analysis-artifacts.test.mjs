import test from "node:test";
import assert from "node:assert/strict";
import { validateAnalysisArtifact } from "../scripts/lib/analysis-artifacts.mjs";

test("accepts the complete Batchmate game-summary artifact", () => {
  const games = Array.from({ length: 12 }, (_, index) => ({
    name: "Game " + index,
    top: [{ ticket: "123" }]
  }));
  assert.deepEqual(validateAnalysisArtifact("batchmate_data", {
    generated: "2026-11-20 01:00",
    games
  }), {
    key: "batchmate_data",
    generatedAt: "2026-11-20 01:00",
    itemCount: 12,
    detailCount: 12
  });
});

test("rejects an incomplete Batchmate game-summary artifact", () => {
  assert.throws(
    () => validateAnalysisArtifact("batchmate_data", {
      generated: "2026-11-20 01:00",
      games: [{ name: "Pick 3 Morning", top: [] }]
    }),
    /all 12 generated game\/session summaries/
  );
});

test("accepts the complete tight-ticket artifact with 17 latest streams", () => {
  const latest = Array.from({ length: 17 }, (_, index) => ({
    game: "Game " + index,
    session: "draw",
    date: "2026-11-20",
    numbers: "1,2,3"
  }));
  const tickets = [{ game: "Pick 3", ticket: "123" }];
  assert.deepEqual(validateAnalysisArtifact("tight_tickets", {
    generated: "2026-11-20T01:00:00",
    tickets,
    latest_draws: latest
  }), {
    key: "tight_tickets",
    generatedAt: "2026-11-20T01:00:00",
    itemCount: 1,
    detailCount: 17
  });
});

test("rejects duplicate latest streams in tight-ticket data", () => {
  const latest = Array.from({ length: 17 }, (_, index) => ({
    game: index < 2 ? "Duplicate" : "Game " + index,
    session: index < 2 ? "morning" : "draw",
    date: "2026-11-20",
    numbers: "1,2,3"
  }));
  assert.throws(
    () => validateAnalysisArtifact("tight_tickets", {
      generated: "2026-11-20T01:00:00",
      tickets: [{ game: "Pick 3", ticket: "123" }],
      latest_draws: latest
    }),
    /duplicate latest drawing stream/
  );
});
