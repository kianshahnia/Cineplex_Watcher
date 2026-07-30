/**
 * Batch seat selection — the rules behind clicking a row letter, and behind the
 * Select all / Deselect all controls above the seat map.
 *
 * Lives in `lib/` rather than inside `SeatMap.tsx` for the reason the rest of
 * this project's pure rules do (see `lib/experienceTypes.ts`,
 * `lib/watchSelection.ts`, `lib/bulkSelection.ts`): a module that imports a CSS
 * module cannot be loaded outside a bundler, so keeping the algebra DOM-free is
 * what makes it verifiable at all.
 *
 * Typed against a minimal `{ id, status }` shape rather than `SeatDetail`, which
 * keeps the module free of the `@/lib/api` import — and therefore free of the
 * path alias a harness would otherwise need a throwaway tsconfig to resolve.
 */

/** The only two fields of a seat these rules care about. */
export interface RowSeatLike {
  id: string;
  status: string;
}

/** The only field of a layout row these rules care about. */
export interface RowLike {
  seats: readonly RowSeatLike[];
}

/** Stable empty set — shared by every "nothing here" lookup. Never mutate. */
const NONE: ReadonlySet<string> = new Set<string>();

/**
 * Can this seat be picked?
 *
 * - `Available` / `Occupied` are both pickable. Watching an occupied seat is the
 *   whole point of the app; watching a free one is merely less useful.
 * - Anything else is `Unknown` — absent from the availability map, so there is
 *   no seat there to watch.
 * - An already-committed seat is locked: there is no per-seat delete endpoint,
 *   so a click could add but never take away.
 */
export function isSelectableSeat(
  seat: RowSeatLike,
  watchedIds: ReadonlySet<string> = NONE,
): boolean {
  if (seat.status !== "Available" && seat.status !== "Occupied") return false;
  return !watchedIds.has(seat.id);
}

/** What a row-letter click should do, or `null` when the row offers nothing. */
export interface RowPaint {
  /** The selectable seats in the row, in layout order. Never empty. */
  seatIds: string[];
  /** true = pick them all, false = drop them all. */
  select: boolean;
}

/**
 * Resolve a row-letter click.
 *
 * A **partly-picked row fills rather than clears** — someone who picked two
 * seats and then hit the letter meant "all of them". That is the same rule the
 * dashboard's group checkboxes use (`lib/bulkSelection.ts:toggleGroup`), and the
 * reason `select` is derived from `every` rather than from a count.
 *
 * Returns `null` for a row with no selectable seats (all locked, all unknown, or
 * an aisle), so the caller renders no affordance instead of a dead target.
 * Guarding on that also keeps `every` from being **vacuously true** on an empty
 * row and reporting "already all picked" for a row holding nothing.
 */
export function rowPaint(
  seats: readonly RowSeatLike[],
  watchedIds: ReadonlySet<string> = NONE,
  selectedIds: ReadonlySet<string> = NONE,
): RowPaint | null {
  const seatIds = seats
    .filter((seat) => isSelectableSeat(seat, watchedIds))
    .map((seat) => seat.id);
  if (seatIds.length === 0) return null;
  const allPicked = seatIds.every((id) => selectedIds.has(id));
  return { seatIds, select: !allPicked };
}

/** What the Select all / Deselect all pair has to work with. */
export interface BulkSelectState {
  /** Every selectable seat on the map, in layout order. */
  seatIds: string[];
  /** How many of them are already picked. */
  pickedCount: number;
}

/**
 * Resolve the whole-map selection controls.
 *
 * Two explicit buttons rather than one toggle: Select all and Deselect all
 * report *what they will do* rather than what state the map happens to be in,
 * which is the point of the control — the old "watch all seats" flag committed
 * to every seat with nothing to show for it on the map.
 *
 * Counts are returned rather than booleans so the caller can label the buttons
 * ("258 seats") and decide its own disabled rules. Note that `pickedCount`
 * counts only *selectable* seats: a committed seat is picked in the user's mind
 * but is not something either button can move, so including it would make
 * "Select all" look done while unpicked seats remained.
 */
export function bulkSelectState(
  rows: readonly RowLike[],
  watchedIds: ReadonlySet<string> = NONE,
  selectedIds: ReadonlySet<string> = NONE,
): BulkSelectState {
  const seatIds: string[] = [];
  let pickedCount = 0;
  for (const row of rows) {
    for (const seat of row.seats) {
      if (!isSelectableSeat(seat, watchedIds)) continue;
      seatIds.push(seat.id);
      if (selectedIds.has(seat.id)) pickedCount += 1;
    }
  }
  return { seatIds, pickedCount };
}
