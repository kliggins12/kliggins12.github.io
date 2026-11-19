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

function uniqueIds(markings: Marking[]): void {
  const ids = new Set<string>();
  for (const marking of markings) {
    if (!marking.id || ids.has(marking.id)) {
      throw new Error("Every board marking must have a unique, non-empty ID.");
    }
    ids.add(marking.id);
    checkedPosition(marking.position);
  }
}

function rowAt(position: BoardPosition, offset: number): number {
  return (position.row + offset + PICK3_ROWS) % PICK3_ROWS;
}

/**
 * Cascade displacement on one Pick 3 column.
 *
 * An incoming marking takes the target slot. If occupied, each displaced
 * marking advances by the attacker's offset, wrapping around rows 0..9, until
 * an empty slot is found. No marking is silently overwritten. A full column,
 * or an offset of zero when displacement is needed, is reported as a conflict.
 *
 * This operation changes markings only; it does not alter drawing history.
 */
export function cascadeDisplace(args: {
  markings: Marking[];
  incoming: Marking;
  target: BoardPosition;
  attackerValue: number;
  direction: CascadeDirection;
}): { markings: Marking[]; changes: BoardChange[] } {
  uniqueIds(args.markings);
  checkedPosition(args.target);
  if (args.markings.some((m) => m.id === args.incoming.id)) {
    throw new Error(`Incoming marking ${args.incoming.id} already exists on this board.`);
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
  const occupant = byRow.get(args.target.row);

  if (!occupant) {
    result.push(copy(args.incoming, args.target));
    changes.push({
      type: "mark",
      markingId: args.incoming.id,
      to: { ...args.target },
      detail: "Incoming marking occupies an empty slot."
    });
    return { markings: result, changes };
  }

  if (step === 0) {
    throw new Error("Cannot displace an occupied slot by zero rows.");
  }

  // Find the first empty slot along the circular displacement path.
  let emptyRow = -1;
  for (let distance = 1; distance < PICK3_ROWS; distance++) {
    const candidate = rowAt(args.target, step * distance);
    if (!byRow.has(candidate)) {
      emptyRow = candidate;
      break;
    }
  }
  if (emptyRow < 0) {
    throw new Error("Cascade cannot insert into a completely occupied column.");
  }

  // Move the chain from its empty end backwards, preserving every marking.
  let destination = emptyRow;
  while (destination !== args.target.row) {
    const source = rowAt(
      args.target,
      step * ((Math.round((((destination - args.target.row) % PICK3_ROWS) + PICK3_ROWS) % PICK3_ROWS) /
        (Math.abs(step) % PICK3_ROWS || PICK3_ROWS)) % PICK3_ROWS)
    );
    // Use the actual predecessor on the modular path, not a numeric row sort.
    const predecessor = rowAt(destination === emptyRow ? args.target : { row: destination, column }, -step);
    const moving = byRow.get(predecessor);
    if (!moving) break;
    byRow.delete(predecessor);
    byRow.set(destination, copy(moving, { row: destination, column }));
    changes.push({
      type: "displace",
      markingId: moving.id,
      from: { row: predecessor, column },
      to: { row: destination, column },
      detail: `Displaced by ${args.attackerValue} rows with circular wrap.`
    });
    destination = predecessor;
  }

  byRow.delete(args.target.row);
  byRow.set(args.target.row, copy(args.incoming, args.target));
  changes.unshift({
    type: "mark",
    markingId: args.incoming.id,
    to: { ...args.target },
    detail: "Incoming marking takes the occupied slot; the existing marking is displaced."
  });

  result.push(...byRow.values());
  return { markings: result, changes };
}

/**
 * Rotate every marking in one column by a selected value, with circular wrap.
 * Other columns and their markings are left unchanged.
 */
export function rotateColumn(args: {
  markings: Marking[];
  column: number;
  value: number;
  direction: RotationDirection;
}): { markings: Marking[]; changes: BoardChange[] } {
  uniqueIds(args.markings);
  if (!Number.isInteger(args.column) || args.column < 0 || args.column >= PICK3_COLUMNS) {
    throw new Error("Pick 3 column index must be 0, 1, or 2.");
  }
  if (!Number.isInteger(args.value) || args.value < 0 || args.value > 9) {
    throw new Error("Pick 3 rotation value must be an integer from 0 through 9.");
  }
  const offset = args.value * (args.direction === "up" ? -1 : 1);
  const markings = args.markings.map((marking) => {
    if (marking.position.column !== args.column) return copy(marking);
    return copy(marking, {
      row: rowAt(marking.position, offset),
      column: args.column
    });
  });
  const changes = markings.flatMap((marking, index) => {
    const before = args.markings[index];
    if (before.position.column !== args.column || before.position.row === marking.position.row) return [];
    return [{
      type: "rotate" as const,
      markingId: marking.id,
      from: { ...before.position },
      to: { ...marking.position },
      detail: `Column ${args.column + 1} rotated ${args.value} rows ${args.direction} with circular wrap.`
    }];
  });
  return { markings, changes };
}

/**
 * Swap two selected markings only. Every unrelated marking stays in place.
 * This supports the historical piece-swap rule without moving whole combos.
 */
export function swapMarkings(args: {
  markings: Marking[];
  firstId: string;
  secondId: string;
}): { markings: Marking[]; changes: BoardChange[] } {
  uniqueIds(args.markings);
  if (args.firstId === args.secondId) {
    throw new Error("A marking cannot be swapped with itself.");
  }
  const first = args.markings.find((m) => m.id === args.firstId);
  const second = args.markings.find((m) => m.id === args.secondId);
  if (!first || !second) {
    throw new Error("Both selected markings must exist on the same board.");
  }

  const markings = args.markings.map((marking) => {
    if (marking.id === first.id) return copy(marking, second.position);
    if (marking.id === second.id) return copy(marking, first.position);
    return copy(marking);
  });
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
