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

  // Walk the circular path: target, target + step, ... until an empty slot.
  const path: number[] = [args.target.row];
  let emptyRow = -1;
  for (let distance = 1; distance < PICK3_ROWS; distance++) {
    const candidate = rowAt(args.target, step * distance);
    path.push(candidate);
    if (!byRow.has(candidate)) {
      emptyRow = candidate;
      break;
    }
  }
  if (emptyRow < 0) {
    throw new Error("Cascade cannot insert into a completely occupied column.");
  }

  // Shift each occupied marking one path position toward the empty slot.
  for (let index = path.length - 1; index >= 1; index--) {
    const fromRow = path[index - 1];
    const toRow = path[index];
    const moving = byRow.get(fromRow);
    if (!moving) {
      throw new Error("Cascade path contains an unexpected empty slot.");
    }
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
    detail: "Incoming marking takes the target slot; the occupied marking chain advances to the first empty slot."
  });
