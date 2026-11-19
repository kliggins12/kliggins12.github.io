const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const build = process.env.PICK3_BUILD_DIR;
if (!build) throw new Error("PICK3_BUILD_DIR is required; run npm test.");
const model = require(path.join(build, "analysis", "pick3.js"));
const moves = require(path.join(build, "analysis", "pick3-movements.js"));
const replay = require(path.join(build, "analysis", "pick3-replay.js"));

function marking(id, row, column, value = id) {
  return { id, position: { row, column }, kind: "test", value, createdByDrawId: "fixture" };
}

function byId(markings) {
  return Object.fromEntries(markings.map((m) => [m.id, m.position]));
}

test("Pick 3 board geometry and initial anchors are 10x3 and 0,0,0", () => {
  const board = model.createInitialPick3Board("morning");
  assert.equal(board.rows, 10);
  assert.equal(board.columns, 3);
  assert.deepEqual(board.initialAnchors, [0, 0, 0]);
  assert.equal(board.markings.length, 3);
  assert.deepEqual(byId(board.markings), {
    "pick3-initial-anchor-1": { row: 0, column: 0 },
    "pick3-initial-anchor-2": { row: 0, column: 1 },
    "pick3-initial-anchor-3": { row: 0, column: 2 }
  });
  assert.ok(board.markings.every((m) => m.kind === "initial-anchor" && m.value === 0));
});

test("cascade advances an occupied chain by attacker value", () => {
  const result = moves.cascadeDisplace({
    markings: [marking("a", 1, 0), marking("b", 3, 0), marking("stay", 2, 1)],
    incoming: marking("incoming", 1, 0, "new"),
    target: { row: 1, column: 0 },
    attackerValue: 2,
    direction: "down"
  });
  assert.deepEqual(byId(result.markings), {
    incoming: { row: 1, column: 0 },
    stay: { row: 2, column: 1 },
    a: { row: 3, column: 0 },
    b: { row: 5, column: 0 }
  });
  assert.equal(result.changes.filter((c) => c.type === "displace").length, 2);
});

test("cascade supports circular wrap around the 10-row board", () => {
  const result = moves.cascadeDisplace({
    markings: [marking("edge", 9, 2)],
    incoming: marking("new", 9, 2),
    target: { row: 9, column: 2 },
    attackerValue: 3,
    direction: "down"
  });
  assert.deepEqual(byId(result.markings), {
    new: { row: 9, column: 2 },
    edge: { row: 2, column: 2 }
  });
});

test("cascade rejects zero displacement and full columns rather than overwriting", () => {
  assert.throws(() => moves.cascadeDisplace({
    markings: [marking("a", 0, 0)],
    incoming: marking("n", 0, 0),
    target: { row: 0, column: 0 },
    attackerValue: 0,
    direction: "down"
  }), /zero rows/);

  const full = Array.from({ length: 10 }, (_, row) => marking("r" + row, row, 0));
  assert.throws(() => moves.cascadeDisplace({
    markings: full,
    incoming: marking("new", 0, 0),
    target: { row: 0, column: 0 },
    attackerValue: 1,
    direction: "down"
  }), /completely occupied/);
});

test("whole-column rotation moves only the selected column", () => {
  const result = moves.rotateColumn({
    markings: [marking("a", 0, 0), marking("b", 9, 0), marking("c", 4, 1)],
    column: 0,
    value: 2,
    direction: "up"
  });
  assert.deepEqual(byId(result.markings), {
    a: { row: 8, column: 0 },
    b: { row: 7, column: 0 },
    c: { row: 4, column: 1 }
  });
});

test("piece swap exchanges only selected markings", () => {
  const result = moves.swapMarkings({
    markings: [marking("a", 0, 0), marking("b", 5, 2), marking("fixed", 4, 1)],
    firstId: "a",
    secondId: "b"
  });
  assert.deepEqual(byId(result.markings), {
    a: { row: 5, column: 2 },
    b: { row: 0, column: 0 },
    fixed: { row: 4, column: 1 }
  });
});

test("replay freezes each assumption before seeing target digits and links rolling versions", () => {
  const draws = [
    { id: "d1", session: "morning", date: "2020-01-01", digits: [1, 2, 3] },
    { id: "d2", session: "morning", date: "2020-01-02", digits: [4, 5, 6] },
    { id: "d3", session: "morning", date: "2020-01-03", digits: [7, 8, 9] }
  ];
  const targetKeys = [];
  const result = replay.replayPick3Session({
    session: "morning",
    draws,
    createdAt: (target) => "frozen-at-" + target.id,
    strategy: {
      projectNext(board, target) {
        targetKeys.push(Object.keys(target).sort());
        return { projectedMarkings: board.markings, changes: [] };
      },
      applyDraw(board, draw) {
        const existing = board.markings.map((m) => ({
          ...m,
          position: { row: draw.digits[0], column: m.position.column }
        }));
        return { resultingMarkings: existing, changes: [] };
      }
    }
  });

  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].assumption.sourceCutoffDate, null);
  assert.equal(result.steps[1].assumption.sourceCutoffDate, "2020-01-01");
  assert.equal(result.steps[1].assumption.predecessorAssumptionId, "pick3:morning:2020-01-01");
  assert.equal(result.steps[2].assumption.sourceCutoffDate, "2020-01-02");
  assert.deepEqual(targetKeys, [
    ["date", "id", "session"],
    ["date", "id", "session"],
    ["date", "id", "session"]
  ]);
  assert.equal(result.steps[0].evaluation.actualDrawId, "d1");
  assert.equal(result.steps[1].evaluation.actualDrawId, "d2");
  assert.equal(result.finalBoard.asOfDate, "2020-01-03");
  assert.equal(result.steps[0].assumption.sourceBoardMarkings.length, 3);
  assert.equal(result.steps[1].assumption.sourceBoardMarkings[0].position.row, 1);
});

test("replay rejects a cross-session draw and duplicate/non-increasing dates", () => {
  const strategy = {
    projectNext: () => ({ projectedMarkings: [], changes: [] }),
    applyDraw: () => ({ resultingMarkings: [], changes: [] })
  };
  assert.throws(() => replay.replayPick3Session({
    session: "morning",
    draws: [{ id: "d", session: "day", date: "2020-01-01", digits: [1, 2, 3] }],
    strategy
  }), /another Pick 3 session/);
  assert.throws(() => replay.replayPick3Session({
    session: "morning",
    draws: [
      { id: "d1", session: "morning", date: "2020-01-01", digits: [1, 2, 3] },
      { id: "d2", session: "morning", date: "2020-01-01", digits: [2, 3, 4] }
    ],
    strategy
  }), /strictly increasing order/);
});
