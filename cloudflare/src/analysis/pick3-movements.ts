import {
  PICK3_COLUMNS,
  PICK3_ROWS,
  type BoardChange,
  type BoardPosition,
  type Marking
} from "./pick3";

export type CascadeDirection = "up" | "down";
export type RotationDirection = "up" | "down";

function checkedPosition(position: BoardPosition): void {
  if (!Number.isInteger(position.row) || position.row < 0 || position.row >= PICK3_ROWS ||
      !Number.isInteger(position.column) || position.column < 0 || position.column >= PICK3_COLUMNS) {
    throw new Error("Position is outside the 10×3 Pick 3 board.");
  }
}

function copy(marking: Marking, position = marking.position): Marking {
  return { ...marking, position: { row: position.row, column: position.column } };
}

function validateBoard(markings: Marking[]): void {
  const ids = new Set<string>();
  const occupied = new Set<string>();
  for (const marking of markings) {
    if (!marking.id || ids.has(marking.id)) {
      throw new Error("Every board marking must have a unique, non-empty ID.");
    }
    ids.add(marking.id);
    checkedPosition(marking.position);
    const slot = `${marking.position.row}:${marking.position.column}`;
    if (occupied.has(slot)) throw new Error(`Multiple markings occupy board slot ${slot}.`);
    occupied.add(slot);
  }
}

function rowAt(position: BoardPosition, offset: number): number {
  return ((position.row + offset) % PICK3_ROWS + PICK3_ROWS) % PICK3_ROWS;
}

/**
 * Cascade displacement on one Pick 3 column.
 *
 * The incoming marking takes the target slot. Each occupant along the chosen
 * circular path moves by the attacker's value until the first empty slot.
 * No marking is overwritten. If the column is full, the operation fails.
 */
export function cascadeDisplace(args: {
  markings: Marking[];
  incoming: Marking;
  target: BoardPosition;
  attackerValue: number;
  direction: CascadeDirection;
}): { markings: Marking[]; changes: BoardChange[] } {
  validateBoard(args.markings);
  checkedPosition(args.target);
  if (!args.incoming.id || args.markings.some((m) => m.id === args.incoming.id)) {
    throw new Error("Incoming marking must have a new, non-empty ID.");
  }
  if (!Number.isInteger(args.attackerValue) || args.attackerValue < 0 || args.attackerValue > 9) {
    throw new Error("Pick 3 displacement value must be an integer from 0 through 9.");
  }

  const column = args.target.column;
  const step = args.attackerValue * (args.direction === "up" ? -1 : 1);
  const byRow = new Map<number, Marking>();
  for (const marking of args.markings) {
    if (marking.position.column === column) byRow.set(marking.position.row, marking);
  }

  const changes: BoardChange[] = [];
  const result = args.markings.filter((m) => m.position.column !== column).map((m) => copy(m));
  if (!byRow.has(args.target.row)) {
    result.push(copy(args.incoming, args.target));
    changes.push({
      type: "mark",
      markingId: args.incoming.id,
      to: { ...args.target },
      detail: "Incoming marking occupies an empty slot."
    });
    return { markings: result, changes };
  }
  if (step === 0) throw new Error("Cannot displace an occupied slot by zero rows.");

  const path: number[] = [args.target.row];
  let foundEmpty = false;
  for (let distance = 1; distance < PICK3_ROWS; distance++) {
    const row = rowAt(args.target, step * distance);
    path.push(row);
    if (!byRow.has(row)) {
      foundEmpty = true;
      break;
    }
  }
  if (!foundEmpty) throw new Error("Cascade cannot insert into a completely occupied column.");

  for (let index = path.length - 1; index >= 1; index--) {
    const fromRow = path[index - 1];
    const toRow = path[index];
    const moving = byRow.get(fromRow);
    if (!moving) throw new Error("Cascade path contains an unexpected empty slot.");
    byRow.delete(fromRow);
    byRow.set(toRow, copy(moving, { row: toRow, column }));
    changes.push({
      type: "displace",
      markingId: moving.id,
      from: { row: fromRow, column },
      to: { row: toRow, column },
      detail: `Displaced by ${args.attackerValue} rows with circular wrap.`
    });
  }

  byRow.set(args.target.row, copy(args.incoming, args.target));
  changes.unshift({
    type: "mark",
    markingId: args.incoming.id,
    to: { ...args.target },
    detail: "Incoming marking takes the target slot; displaced markings advance to the first empty slot."
  });
  result.push(...byRow.values());
  validateBoard(result);
  return { markings: result, changes };
}

/** Rotate every marking in one column, with circular wrap. */
export function rotateColumn(args: {
  markings: Marking[];
  column: number;
  value: number;
  direction: RotationDirection;
}): { markings: Marking[]; changes: BoardChange[] } {
  validateBoard(args.markings);
  if (!Number.isInteger(args.column) || args.column < 0 || args.column >= PICK3_COLUMNS) {
    throw new Error("Pick 3 column index must be 0, 1, or 2.");
  }
  if (!Number.isInteger(args.value) || args.value < 0 || args.value > 9) {
    throw new Error("Pick 3 rotation value must be an integer from 0 through 9.");
  }

  const offset = args.value * (args.direction === "up" ? -1 : 1);
  const markings = args.markings.map((marking) => {
    if (marking.position.column !== args.column) return copy(marking);
    return copy(marking, { row: rowAt(marking.position, offset), column: args.column });
  });
  const changes: BoardChange[] = [];
  for (let index = 0; index < markings.length; index++) {
    const before = args.markings[index];
    const after = markings[index];
    if (before.position.row === after.position.row && before.position.column === after.position.column) continue;
    changes.push({
      type: "rotate",
      markingId: after.id,
      from: { ...before.position },
      to: { ...after.position },
      detail: `Column ${args.column + 1} rotated ${args.value} rows ${args.direction} with circular wrap.`
    });
  }
  validateBoard(markings);
  return { markings, changes };
}

/** Swap only two selected markings; all unrelated markings remain fixed. */
export function swapMarkings(args: {
  markings: Marking[];
  firstId: string;
  secondId: string;
}): { markings: Marking[]; changes: BoardChange[] } {
  validateBoard(args.markings);
  if (args.firstId === args.secondId) throw new Error("A marking cannot be swapped with itself.");
  const first = args.markings.find((m) => m.id === args.firstId);
  const second = args.markings.find((m) => m.id === args.secondId);
  if (!first || !second) throw new Error("Both selected markings must exist on the same board.");

  const markings = args.markings.map((marking) => {
    if (marking.id === first.id) return copy(marking, second.position);
    if (marking.id === second.id) return copy(marking, first.position);
    return copy(marking);
  });
  validateBoard(markings);
  return {
    markings,
    changes: [
      {
        type: "swap",
        markingId: first.id,
        from: { ...first.position },
        to: { ...second.position },
        detail: `Swapped with marking ${second.id}; unrelated markings remain fixed.`
      },
      {
        type: "swap",
        markingId: second.id,
        from: { ...second.position },
        to: { ...first.position },
        detail: `Swapped with marking ${first.id}; unrelated markings remain fixed.`
      }
    ]
  };
}
