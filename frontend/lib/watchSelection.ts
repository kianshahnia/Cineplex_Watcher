/**
 * Persistence for the watch page's multi-showtime working set.
 *
 * The working set is keyed by the **anchor** (the theatre + the showtime whose
 * link the user pasted) and holds every showtime's picks as one blob, so a
 * sign-in round trip restores all of them at once rather than only whichever
 * times were ticked at the moment. Picks are keyed by Cineplex showtime id, not
 * by our internal UUID, so nothing here needs a showtime's row to have been
 * loaded.
 *
 * The blob also carries the ticked set — otherwise a signed-out visitor who
 * ticked three showtimes would come back from the magic link to a page that had
 * forgotten which showtimes their picks were meant for.
 *
 * The parse/serialize half is deliberately pure and DOM-free — that is what
 * makes the format migrations verifiable without a browser.
 */

const STORAGE_PREFIX = "cinewatch.selection.";

/** Uncommitted seat picks, keyed by Cineplex showtime id. */
export type SelectionMap = Map<number, Set<string>>;

export interface WorkingSet {
  selections: SelectionMap;
  /** Showtimes every pick applies to. Always holds at least the anchor. */
  ticked: Set<number>;
}

export function emptyWorkingSet(): WorkingSet {
  return { selections: new Map(), ticked: new Set() };
}

export function selectionStorageKey(
  theatreId: number,
  anchorId: number,
): string {
  return `${STORAGE_PREFIX}${theatreId}.${anchorId}`;
}

/** Stable empty set — shared by every "no picks here" lookup. Never mutate. */
const NO_SEATS: ReadonlySet<string> = new Set<string>();

// --- selection algebra ----------------------------------------------------

/** Every seat picked at any of `ids` — the shared set the seat map edits. */
export function unionPicks(
  selections: SelectionMap,
  ids: Iterable<number>,
): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    for (const seatId of selections.get(id) ?? NO_SEATS) out.add(seatId);
  }
  return out;
}

/**
 * The selection invariant: every ticked showtime holds exactly `seats`, and
 * nothing else holds anything.
 *
 * Unticking a time therefore drops its picks — that is what a tick box means,
 * and it keeps the CTA's "N seats across M showtimes" count honest. Ticking a
 * new time makes it inherit the shared set.
 */
export function groupedSelections(
  ticked: ReadonlySet<number>,
  seats: ReadonlySet<string>,
): SelectionMap {
  const out: SelectionMap = new Map();
  if (seats.size === 0) return out;
  for (const id of ticked) out.set(id, new Set(seats));
  return out;
}

// --- pure parse / serialize ------------------------------------------------

/**
 * Read the `selections` half out of an already-parsed value. Accepts two shapes:
 *
 * - `{"576008": ["1_7_4"], "576007": [...]}` — the per-showtime form.
 * - `["1_7_4", ...]` — the pre-switcher form, a bare array of the anchor's seat
 *   ids. Read as the anchor's selection so a pick in progress isn't dropped the
 *   first time a user loads the switcher UI.
 *
 * Anything unreadable yields an empty map: a corrupt blob should cost the user
 * their picks, never the page.
 */
function readSelections(parsed: unknown, anchorId: number): SelectionMap {
  const out: SelectionMap = new Map();

  if (Array.isArray(parsed)) {
    const ids = parsed.filter((x): x is string => typeof x === "string");
    if (ids.length > 0) out.set(anchorId, new Set(ids));
    return out;
  }

  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      // Number("") is 0 and Number("1e3") is 1000 — neither is a showtime id we
      // ever wrote, so require the key to round-trip exactly.
      if (!Number.isInteger(id) || String(id) !== key) continue;
      if (!Array.isArray(value)) continue;
      const ids = value.filter((x): x is string => typeof x === "string");
      if (ids.length > 0) out.set(id, new Set(ids));
    }
  }
  return out;
}

function readIdSet(parsed: unknown): Set<number> {
  const out = new Set<number>();
  if (!Array.isArray(parsed)) return out;
  for (const value of parsed) {
    if (typeof value === "number" && Number.isInteger(value)) out.add(value);
  }
  return out;
}

export function parseStoredSelections(
  raw: string | null,
  anchorId: number,
): SelectionMap {
  return parseStoredWorkingSet(raw, anchorId).selections;
}

/**
 * Read a stored blob. Four shapes are accepted, newest first:
 *
 * - `{"v":3,"selections":{…},"ticked":[…]}` — the current form.
 * - `{"v":2,…,"mode":"grouped"}` — same, from when the page had two selection
 *   modes. The `mode` key is read and discarded; the ticked set it was written
 *   with is still exactly what the one remaining mode wants.
 * - `{"576008":[…]}` — Session 3's bare per-showtime map.
 * - `["1_7_4",…]` — the original bare array of the anchor's picks.
 *
 * The wrapper is distinguishable from the bare map because a showtime-id key can
 * never be the literal string `selections` — the map's keys always round-trip as
 * integers.
 */
export function parseStoredWorkingSet(
  raw: string | null,
  anchorId: number,
): WorkingSet {
  const out = emptyWorkingSet();
  if (!raw) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "selections" in parsed
  ) {
    const obj = parsed as Record<string, unknown>;
    return {
      selections: readSelections(obj.selections, anchorId),
      ticked: readIdSet(obj.ticked),
    };
  }

  out.selections = readSelections(parsed, anchorId);
  return out;
}

/**
 * Serialize a working set, or `null` when there is nothing worth storing (the
 * caller removes the key rather than writing an empty husk).
 *
 * `anchorId` is what makes "nothing worth storing" meaningful: the anchor is
 * ticked from the moment the page loads, so a blob holding only the anchor and
 * no picks describes a visitor who has done nothing at all.
 */
export function serializeWorkingSet(
  ws: WorkingSet,
  anchorId: number,
): string | null {
  const selections: Record<string, string[]> = {};
  for (const [id, seats] of ws.selections) {
    if (seats.size > 0) selections[String(id)] = [...seats];
  }
  const ticked = [...ws.ticked].sort((a, b) => a - b);

  const untouched =
    ticked.length === 0 || (ticked.length === 1 && ticked[0] === anchorId);
  if (Object.keys(selections).length === 0 && untouched) return null;

  return JSON.stringify({ v: 3, selections, ticked });
}

// --- localStorage wrappers -------------------------------------------------

export function loadWorkingSet(
  theatreId: number,
  anchorId: number,
): WorkingSet {
  if (typeof window === "undefined") return emptyWorkingSet();
  try {
    return parseStoredWorkingSet(
      window.localStorage.getItem(selectionStorageKey(theatreId, anchorId)),
      anchorId,
    );
  } catch {
    // privacy mode can throw on read
    return emptyWorkingSet();
  }
}

export function saveWorkingSet(
  theatreId: number,
  anchorId: number,
  ws: WorkingSet,
): void {
  if (typeof window === "undefined") return;
  const key = selectionStorageKey(theatreId, anchorId);
  const payload = serializeWorkingSet(ws, anchorId);
  try {
    if (payload === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, payload);
    }
  } catch {
    // ignore quota / privacy-mode errors
  }
}
