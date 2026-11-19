import {
  commitPick3BoardAfterDraw,
  createInitialPick3Board,
  evaluatePick3Assumption,
  freezePick3Assumption,
  rollPick3Assumption,
  validatePick3Draw,
  type AssumptionEvaluation,
  type BoardChange,
  type FrozenAssumption,
  type Marking,
  type Pick3BoardState,
  type Pick3Draw,
  type Pick3Session
} from "./pick3";

export type Pick3Target = Pick<Pick3Draw, "id" | "session" | "date">;

export type Pick3Projection = {
  projectedMarkings: Marking[];
  changes: BoardChange[];
};

export type Pick3AppliedDraw = {
  resultingMarkings: Marking[];
  changes: BoardChange[];
};

/**
 * The strategy is the game-specific marking-rule implementation.
 * projectNext receives NO target digits, enforcing no-lookahead assumptions.
 */
export interface Pick3MarkingStrategy {
  projectNext(board: Pick3BoardState, target: Pick3Target): Pick3Projection;
  applyDraw(board: Pick3BoardState, draw: Pick3Draw): Pick3AppliedDraw;
}

export type Pick3ReplayStep = {
  sequence: number;
  target: Pick3Target;
  assumption: FrozenAssumption;
  actualDraw: Pick3Draw;
  appliedChanges: BoardChange[];
  evaluation: AssumptionEvaluation;
  resultingBoard: Pick3BoardState;
};

export type Pick3ReplayResult = {
  game: "Pick 3";
  session: Pick3Session;
  initialBoard: Pick3BoardState;
  finalBoard: Pick3BoardState;
  steps: Pick3ReplayStep[];
};

/**
 * Replays one Pick 3 session from earliest to latest.
 *
 * For each drawing:
 *  1. Generate and freeze a mock board assumption using only the prior board.
 *  2. Reveal/apply the actual drawing through the marking strategy.
 *  3. Compare the frozen projected markings with the actual resulting board.
 *  4. Carry the resulting board into a newly linked assumption for the next draw.
 *
 * Each assumption is immutable. Rolling forward creates a successor record;
 * it never edits the predecessor's historical state.
 */
export function replayPick3Session(args: {
  session: Pick3Session;
  draws: Pick3Draw[];
  strategy: Pick3MarkingStrategy;
  createdAt?: (target: Pick3Target) => string;
}): Pick3ReplayResult {
  const draws = [...args.draws].sort((a, b) =>
    a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
  );
  for (let i = 0; i < draws.length; i++) {
    validatePick3Draw(draws[i]);
    if (draws[i].session !== args.session) {
      throw new Error("Replay input contains a drawing from another Pick 3 session.");
    }
    if (i > 0 && draws[i].date <= draws[i - 1].date) {
      throw new Error("Replay requires one drawing per date in strictly increasing order.");
    }
  }

  const initialBoard = createInitialPick3Board(args.session);
  let board = initialBoard;
  let previousAssumption: FrozenAssumption | null = null;
  const steps: Pick3ReplayStep[] = [];

  for (let index = 0; index < draws.length; index++) {
    const draw = draws[index];
    const target: Pick3Target = { id: draw.id, session: draw.session, date: draw.date };
    const projection = args.strategy.projectNext(board, target);
    const assumptionId = `pick3:${args.session}:${draw.date}`;
    const createdAt = args.createdAt?.(target);

    const assumption = previousAssumption
      ? rollPick3Assumption({
          id: assumptionId,
          nextBoard: board,
          nextTarget: draw,
          previousAssumption,
          projectedMarkings: projection.projectedMarkings,
          proposedChanges: projection.changes,
          createdAt
        })
      : freezePick3Assumption({
          id: assumptionId,
          board,
          target: draw,
          projectedMarkings: projection.projectedMarkings,
          proposedChanges: projection.changes,
          createdAt
        });

    // The actual digits enter the process only after the assumption is frozen.
    const applied = args.strategy.applyDraw(board, draw);
    const resultingBoard = commitPick3BoardAfterDraw({
      previous: board,
      draw,
      resultingMarkings: applied.resultingMarkings
    });
    const evaluation = evaluatePick3Assumption(assumption, resultingBoard, createdAt);

    steps.push({
      sequence: index + 1,
      target,
      assumption,
      actualDraw: draw,
      appliedChanges: applied.changes,
      evaluation,
      resultingBoard
    });

    board = resultingBoard;
    previousAssumption = assumption;
  }

  return {
    game: "Pick 3",
    session: args.session,
    initialBoard,
    finalBoard: board,
    steps
  };
}
