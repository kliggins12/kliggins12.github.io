/**
 * Pick 3 board replay primitives.
 *
 * This module deliberately separates confirmed board geometry/starting anchors
 * from the still-to-be-implemented marking rules. It never derives board
 * markings from lottery-number frequency or treats a candidate as a prediction.
 */

export const PICK3_ROWS = 10 as const;
export const PICK3_COLUMNS = 3 as const;
export const PICK3_INITIAL_ANCHORS = [0, 0, 0] as const;

export type Pick3Session = "morning" | "day" | "evening" | "night";
export type BoardPosition = { row: number; column: number };

export type Marking = {
  id: string;
  position: BoardPosition;
  kind: string;
  value?: string | number | null;
  createdByDrawId: string;
};

export type Pick3BoardState = {
  game: "Pick 3";
  session: Pick3Session;
  rows: 10;
  columns: 3;
  /** Confirmed initial placement: one zero anchor for each digit column. */
  initialAnchors: readonly [0, 0, 0];
  /** Markings are kept separate from draw digits and retain exact positions. */
  markings: Marking[];
  asOfDrawId: string | null;
  asOfDate: string | null;
  revision: number;
};

export type Pick3DrawTarget = {
  id: string;
  session: Pick3Session;
  date: string;
};

export type Pick3Draw = {
  id: string;
  session: Pick3Session;
  date: string;
  digits: [number, number, number];
};

export type BoardChange = {
  type: "mark" | "unmark" | "move" | "swap" | "displace" | "rotate";
  markingId?: string;
  from?: BoardPosition;
  to?: BoardPosition;
  detail: string;
};

export type FrozenAssumption = {
  id: string;
  game: "Pick 3";
  session: Pick3Session;
  createdAt: string;
  targetDrawId: string;
  targetDrawDate: string;
  sourceCutoffDrawId: string | null;
  sourceCutoffDate: string | null;
  predecessorAssumptionId: string | null;
  boardRevision: number;
  /** Immutable source-board markings available before the target draw. */
  sourceBoardMarkings: Marking[];
  /** Projected board markings for the target draw, produced without its result. */
  projectedMarkings: Marking[];
  /** Human/machine-readable proposed marking changes, not guessed draw digits. */
  proposedChanges: BoardChange[];
};

export type AssumptionEvaluation = {
  assumptionId: string;
  targetDrawId: string;
  actualDrawId: string;
  actualDrawDate: string;
  evaluatedAt: string;
  /** Comparison is about board markings, not a lottery-number hit score. */
  matchedMarkingIds: string[];
  missingMarkingIds: string[];
  unexpectedMarkingIds: string[];
  positionMatches: number;
  positionChanges: Array<{
    markingId: string;
    assumed: BoardPosition;
    actual: BoardPosition | null;
  }>;
};

export function createInitialPick3Board(session: Pick3Session): Pick3BoardState {
  return {
    game: "Pick 3",
    session,
    rows: PICK3_ROWS,
    columns: PICK3_COLUMNS,
    initialAnchors: PICK3_INITIAL_ANCHORS,
    markings: [],
    asOfDrawId: null,
    asOfDate: null,
    revision: 0
  };
}

export function validatePick3Draw(draw: Pick3Draw): void {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(draw.date)) {
    throw new Error(`Invalid Pick 3 draw date: ${draw.date}`);
  }
  if (draw.digits.length !== PICK3_COLUMNS ||
      draw.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    throw new Error("Pick 3 draws must contain exactly three digits from 0 through 9.");
  }
}

function cloneMarkings(markings: Marking[]): Marking[] {
  return markings.map((marking) => ({
    ...marking,
    position: { ...marking.position }
  }));
}

/**
 * Freezes a board snapshot for a specific future draw.
 * The target draw itself must not be used as source evidence.
 */
export function freezePick3Assumption(args: {
  id: string;
  board: Pick3BoardState;
  target: Pick3DrawTarget;
  predecessorAssumptionId?: string | null;
  projectedMarkings: Marking[];
  proposedChanges?: BoardChange[];
  createdAt?: string;
}): FrozenAssumption {
  if (args.board.session !== args.target.session) {
    throw new Error("A Pick 3 assumption cannot cross session boards.");
  }
  if (args.board.asOfDate && args.board.asOfDate >= args.target.date) {
    throw new Error("Assumption source cutoff must be earlier than its target draw.");
  }
  return {
    id: args.id,
    game: "Pick 3",
    session: args.board.session,
    createdAt: args.createdAt ?? new Date().toISOString(),
    targetDrawId: args.target.id,
    targetDrawDate: args.target.date,
    sourceCutoffDrawId: args.board.asOfDrawId,
    sourceCutoffDate: args.board.asOfDate,
    predecessorAssumptionId: args.predecessorAssumptionId ?? null,
    boardRevision: args.board.revision,
    sourceBoardMarkings: cloneMarkings(args.board.markings),
    projectedMarkings: cloneMarkings(args.projectedMarkings),
    proposedChanges: (args.proposedChanges ?? []).map((change) => ({
      ...change,
      from: change.from ? { ...change.from } : undefined,
      to: change.to ? { ...change.to } : undefined
    }))
  };
}

/**
 * Records an actual board state after the draw is processed by the approved
 * marking-rule adapter. This function does not invent those marking rules.
 */
export function commitPick3BoardAfterDraw(args: {
  previous: Pick3BoardState;
  draw: Pick3Draw;
  resultingMarkings: Marking[];
}): Pick3BoardState {
  validatePick3Draw(args.draw);
  if (args.previous.session !== args.draw.session) {
    throw new Error("A draw can only update its own Pick 3 session board.");
  }
  if (args.previous.asOfDate && args.draw.date <= args.previous.asOfDate) {
    throw new Error("Pick 3 board draws must be applied in strictly chronological order.");
  }
  for (const marking of args.resultingMarkings) {
    const { row, column } = marking.position;
    if (!Number.isInteger(row) || row < 0 || row >= PICK3_ROWS ||
        !Number.isInteger(column) || column < 0 || column >= PICK3_COLUMNS) {
      throw new Error(`Marking ${marking.id} is outside the 10×3 Pick 3 board.`);
    }
  }
  return {
    ...args.previous,
    markings: cloneMarkings(args.resultingMarkings),
    asOfDrawId: args.draw.id,
    asOfDate: args.draw.date,
    revision: args.previous.revision + 1
  };
}

/** Compare an assumption's frozen markings with the actual post-draw board. */
export function evaluatePick3Assumption(
  assumption: FrozenAssumption,
  actualBoard: Pick3BoardState,
  evaluatedAt = new Date().toISOString()
): AssumptionEvaluation {
  if (assumption.session !== actualBoard.session) {
    throw new Error("Cannot evaluate an assumption against a different session board.");
  }
  if (actualBoard.asOfDrawId !== assumption.targetDrawId) {
    throw new Error("Actual board does not belong to the assumption's target draw.");
  }

  const assumed = new Map(assumption.projectedMarkings.map((m) => [m.id, m]));
  const actual = new Map(actualBoard.markings.map((m) => [m.id, m]));
  const matchedMarkingIds: string[] = [];
  const missingMarkingIds: string[] = [];
  const unexpectedMarkingIds: string[] = [];
  const positionChanges: AssumptionEvaluation["positionChanges"] = [];

  for (const [id, marking] of assumed) {
    const observed = actual.get(id);
    if (!observed) {
      missingMarkingIds.push(id);
      positionChanges.push({ markingId: id, assumed: { ...marking.position }, actual: null });
    } else if (observed.position.row === marking.position.row &&
               observed.position.column === marking.position.column) {
      matchedMarkingIds.push(id);
    } else {
      positionChanges.push({
        markingId: id,
        assumed: { ...marking.position },
        actual: { ...observed.position }
      });
    }
  }
  for (const id of actual.keys()) {
    if (!assumed.has(id)) unexpectedMarkingIds.push(id);
  }

  return {
    assumptionId: assumption.id,
    targetDrawId: assumption.targetDrawId,
    actualDrawId: actualBoard.asOfDrawId!,
    actualDrawDate: actualBoard.asOfDate!,
    evaluatedAt,
    matchedMarkingIds,
    missingMarkingIds,
    unexpectedMarkingIds,
    positionMatches: matchedMarkingIds.length,
    positionChanges
  };
}

/**
 * Creates a new immutable assumption in the rolling chain. The predecessor
 * remains unchanged and is referenced by ID for full replay/audit history.
 */
export function rollPick3Assumption(args: {
  id: string;
  nextBoard: Pick3BoardState;
  nextTarget: Pick3DrawTarget;
  previousAssumption: FrozenAssumption;
  projectedMarkings: Marking[];
  proposedChanges?: BoardChange[];
  createdAt?: string;
}): FrozenAssumption {
  if (args.nextBoard.asOfDrawId !== args.previousAssumption.targetDrawId) {
    throw new Error("Rolling adjustment requires the previous target draw to have been processed.");
  }
  return freezePick3Assumption({
    id: args.id,
    board: args.nextBoard,
    target: args.nextTarget,
    predecessorAssumptionId: args.previousAssumption.id,
    projectedMarkings: args.projectedMarkings,
    proposedChanges: args.proposedChanges,
    createdAt: args.createdAt
  });
}
