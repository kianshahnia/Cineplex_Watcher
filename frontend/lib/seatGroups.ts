/**
 * Adjacent-seat blocks, frontend half — what the seat panel needs to know before
 * it lets you save a "notify me only when N seats open together" threshold.
 *
 * The authoritative rule lives in `backend/app/services/seat_groups.py`; the
 * poller decides who gets alerted and this file never does. What it answers is a
 * narrower question the backend deliberately cannot: **could this selection ever
 * produce a block of N?** A threshold above that number describes a watch that
 * will sit there until the screening starts and never say a word, which is the
 * footgun the panel refuses to save.
 *
 * That check cannot move server-side, and the reason is worth knowing: `POST
 * /watches` runs *before* `POST /watches/{id}/seats`, so at create time every
 * watch has zero seats. A server-side guard would reject the entire flow rather
 * than the bad case. So the guard is here, and
 * `backend/app/services/seat_groups.py:max_possible_block` mirrors it so the two
 * definitions of "possible" are checked against each other in one harness.
 *
 * Lives in `lib/` rather than inside a component for the standing reason (see
 * `lib/seatRows.ts`, `lib/experienceTypes.ts`, `lib/watchSelection.ts`): a module
 * that imports a CSS module cannot be loaded outside a bundler, so keeping the
 * algebra DOM-free is what makes it verifiable at all. Typed against minimal
 * shapes rather than `SeatDetail`, which also keeps the `@/lib/api` import — and
 * therefore the path alias a harness would need a tsconfig to resolve — out.
 */

/** The only two fields of a seat these rules care about. */
export interface BenchSeatLike {
  id: string;
  /** Grid column. Consecutive columns touch; a gap is an aisle. */
  column: number;
}

/** The only field of a layout row these rules care about. */
export interface BenchRowLike {
  seats: readonly BenchSeatLike[];
}

/** Stable empty set for "nothing picked". Never mutate. */
const NONE: ReadonlySet<string> = new Set<string>();

/**
 * Group seat ids into runs of physically touching seats.
 *
 * One array per bench, in left-to-right column order. A row split by an aisle
 * yields two benches, because you cannot sit next to someone across an aisle; an
 * aisle row (`seats: []`) yields none. Reads the *merged* layout the seat-map
 * endpoint returns, whose `column` is the same value `SeatMap` positions seats
 * from — so this is exactly the adjacency the user sees on screen.
 */
export function buildBenches(rows: readonly BenchRowLike[]): string[][] {
  const benches: string[][] = [];

  for (const row of rows) {
    const placed = [...row.seats]
      .filter((seat) => Number.isInteger(seat.column) && seat.id !== "")
      .sort((a, b) => a.column - b.column);

    let current: string[] = [];
    let prevColumn: number | null = null;
    for (const seat of placed) {
      if (prevColumn !== null && seat.column !== prevColumn + 1) {
        if (current.length > 0) benches.push(current);
        current = [];
      }
      current.push(seat.id);
      prevColumn = seat.column;
    }
    if (current.length > 0) benches.push(current);
  }

  return benches;
}

/**
 * The largest block `picked` could ever produce, if every seat went free.
 *
 * The best case for a selection is that every unpicked seat *between* two of its
 * picks becomes bookable — a free seat can bridge a gap, but a block's ends must
 * be seats the user chose, or one stray pick in an empty row would count as the
 * whole row. So this is the widest span from a first to a last pick within a
 * single bench, and it never sums across an aisle.
 *
 * Returns 0 for an empty selection.
 */
export function maxPossibleBlock(
  benches: readonly string[][],
  picked: ReadonlySet<string> = NONE,
): number {
  let best = 0;
  for (const bench of benches) {
    const first = bench.findIndex((id) => picked.has(id));
    if (first === -1) continue;
    let last = first;
    for (let i = bench.length - 1; i >= first; i -= 1) {
      const id = bench[i];
      if (id !== undefined && picked.has(id)) {
        last = i;
        break;
      }
    }
    best = Math.max(best, last - first + 1);
  }
  return best;
}
