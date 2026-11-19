# Board analysis modules

## Pick 3 foundation

- Board geometry is fixed at 10 rows × 3 columns.
- The initial state contains three zero anchor markings at row 0, columns 0, 1, and 2.
- Morning, Day, Evening, and Night are isolated streams.
- Markings are tracked by identity and exact row/column position.
- `pick3-movements.ts` provides independent operations for cascade displacement, whole-column rotation, and piece-only swaps.
- `pick3-replay.ts` freezes a projected board before the target draw, applies the actual draw afterward, compares the board markings, and links the next assumption to its predecessor.
- Replay target metadata is separated from the actual draw payload so target digits cannot be passed to the assumption-projection function.

## Important boundary

These modules are the board-state and replay foundation. They do not yet decide which movement operation to apply to a real Pick 3 drawing, nor do they infer a projected board from the prior state. The strategy interface requires that game-specific rule adapter. Do not fabricate that adapter or publish performance results until its exact trigger, target slot, direction, and ordering rules are implemented and validated.

## Tests

Run from `cloudflare/`:

```sh
npm test
npm run typecheck
```

The deployment workflow runs both checks before deploying the Worker.

## Persistence

Migration `0003_board_replay.sql` adds immutable run, board-state, frozen-assumption, and evaluation tables. It must be applied to the remote D1 database before a replay processor attempts to write replay history.
