"""Adjacent-seat blocks — the rule behind "only alert me when N seats open together".

A group of four does not want to hear that two seats opened. They want to hear
when *four opened side by side*. ``watches.min_adjacent_seats`` records how big a
block a watch needs; everything in this module answers two questions about it:

- which blocks in this showtime have **just** reached that size (the poller), and
- how big a block a given selection could ever produce (the frontend's guard has
  its own copy in ``frontend/lib/seatGroups.ts`` — this one backs the harness and
  keeps the definition honest on the authoritative side).

Pure: no database, no Redis, no network, no ORM. That is what makes the rule
verifiable offline (``backend/verify_seat_groups.py``), which matters more here
than anywhere else in the codebase — the whole feature is one algorithm, and
getting it subtly wrong means a user silently never hears from us.

Three definitions do all the work
---------------------------------

**A bench** is a run of physically touching seats: same layout row, consecutive
``column`` values. A gap in the column numbering is an aisle or a hole in the
room, and it ends the bench — you cannot sit "next to" someone across an aisle.
``column`` is the grid position the seat map renders from, so this is exactly the
adjacency a user sees on screen.

**A block** is a run of currently-free seats inside one bench, *trimmed to end on
seats the watch tracks*. So a free seat the user never picked can **bridge** a gap
between two seats they did pick — the common accident is watching a row by
clicking only the taken seats, which leaves the already-free ones out and would
otherwise split the row into useless fragments. The trim is what stops the
bridging from running away: one stray pick in a wide empty row yields a block of
one, not a block of the whole row.

    picked   G4 G5 --  G7 G8       (G6 never picked)
    free     G4 G5 G6 G7 G8
    block    [G4 G5 G6 G7 G8]  = 5     bridged through G6, ends on picks

    picked   G4
    free     G1 G2 G3 G4 G5 G6 G7 G8
    block    [G4]              = 1     no runaway

**A block fires** when it reaches the threshold and no block inside the same
seats already had. That comparison against the *previous* poll's availability —
not against ``watched_seats.notified_at`` — is the entire dedup mechanism, and it
is what makes the case the per-seat pipeline cannot express work:

    threshold 2, watching G4 and G5

    poll 5   G4 opens            block = 1        no alert
    poll 9   G5 opens            block = 2, was 1  ALERT  <- the seat that
                                                             mattered flipped
                                                             four polls ago
    poll 12  nothing changed     block = 2, was 2  quiet
    poll 30  G4 taken            block = 1        (G5 alone)
    poll 44  G4 opens again      block = 2, was 1  ALERT  <- the block re-formed,
                                                             so it is news again

Because it is state-crossing rather than seat-history, a block that breaks and
re-forms is news a second time, which is the point: whoever took G4 in poll 30
was competing with the user for it.
"""

from __future__ import annotations

from collections.abc import Iterable

#: Cineplex's ``seatAvailabilities`` value meaning the seat is bookable.
AVAILABLE = "Available"


# ---------------------------------------------------------------------------
# Benches — physical adjacency, straight off the cached seat layout
# ---------------------------------------------------------------------------


def build_benches(seat_layout_json: dict | None) -> list[list[str]]:
    """Group seat keys into runs of physically touching seats.

    Reads the **raw** Cineplex ``seat-layout`` response cached in
    ``showtimes.seat_layout_json`` (not the merged frontend shape), so the poller
    needs no extra upstream request — the row is already in hand.

    One list per bench, seats in left-to-right ``column`` order. A row split by an
    aisle yields two benches; an aisle row (``seats: []``) yields none. Returns
    ``[]`` for a layout that was never cached, which callers must treat as "the
    block rule cannot be evaluated" rather than as "no seats are adjacent".

    Defensive about the payload for the same reason
    ``merge_layout_and_availability`` is: this is upstream JSON, not a validated
    schema. A seat missing an ``id`` or carrying a non-integer ``column`` is
    dropped rather than allowed to corrupt the ordering of everything after it.
    """
    if not seat_layout_json:
        return []

    standard = seat_layout_json.get("standardSeats")
    if not isinstance(standard, dict):
        return []

    benches: list[list[str]] = []
    rows = standard.get("rows")
    if not isinstance(rows, list):
        return []

    for raw_row in rows:
        if not isinstance(raw_row, dict):
            continue
        raw_seats = raw_row.get("seats")
        if not isinstance(raw_seats, list):
            continue

        # (column, seat_id) pairs, sorted — the payload is normally already in
        # column order, but sorting makes the gap detection below independent of
        # that assumption.
        placed: list[tuple[int, str]] = []
        for raw_seat in raw_seats:
            if not isinstance(raw_seat, dict):
                continue
            seat_id = raw_seat.get("id")
            column = raw_seat.get("column")
            # `bool` is an int subclass, so `True` would otherwise pass as column 1.
            if not isinstance(seat_id, str) or not seat_id:
                continue
            if not isinstance(column, int) or isinstance(column, bool):
                continue
            placed.append((column, seat_id))

        placed.sort(key=lambda pair: pair[0])

        current: list[str] = []
        prev_column: int | None = None
        for column, seat_id in placed:
            if prev_column is not None and column != prev_column + 1:
                # Aisle, missing seat, or a duplicate column — either way these
                # two seats do not touch.
                if current:
                    benches.append(current)
                current = []
            current.append(seat_id)
            prev_column = column
        if current:
            benches.append(current)

    return benches


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------


def _block_spans(
    bench: list[str],
    tracked: frozenset[str] | set[str],
    statuses: dict[str, str],
) -> list[tuple[int, int]]:
    """Index spans of free seats in ``bench``, each trimmed to tracked endpoints.

    One span per maximal run of free seats: the run is narrowed inward to the
    first and last tracked seat it contains, which is what makes an untracked
    free seat able to *bridge* a gap between tracked ones but never able to
    *extend* a block past them. A run holding no tracked seat contributes
    nothing — the user is not watching that part of the room.

    Spans are inclusive on both ends and never empty (a single tracked seat is a
    span of length 1).
    """
    spans: list[tuple[int, int]] = []
    run_start: int | None = None

    def close(start: int, end: int) -> None:
        first = next((i for i in range(start, end + 1) if bench[i] in tracked), None)
        if first is None:
            return
        last = next(i for i in range(end, first - 1, -1) if bench[i] in tracked)
        spans.append((first, last))

    for i, seat_id in enumerate(bench):
        if statuses.get(seat_id) == AVAILABLE:
            if run_start is None:
                run_start = i
        elif run_start is not None:
            close(run_start, i - 1)
            run_start = None
    if run_start is not None:
        close(run_start, len(bench) - 1)

    return spans


def _best_block_size(
    bench: list[str],
    tracked: frozenset[str] | set[str],
    statuses: dict[str, str],
) -> int:
    """Size of the largest block in ``bench`` under ``statuses`` (0 if none)."""
    spans = _block_spans(bench, tracked, statuses)
    return max((end - start + 1 for start, end in spans), default=0)


def find_new_blocks(
    benches: Iterable[list[str]],
    tracked: frozenset[str] | set[str],
    prev_statuses: dict[str, str],
    new_statuses: dict[str, str],
    min_size: int,
) -> list[list[str]]:
    """Blocks that have **just** reached ``min_size``, as ordered seat-key lists.

    A block is reported when it is at least ``min_size`` seats and the same seats
    held no block that big on the previous poll. Comparing the two snapshots is
    what keeps a steady state quiet without consulting ``notified_at``: an
    unchanged room produces identical blocks on both sides and reports nothing, so
    the caller can run this every cycle.

    ``min_size < 2`` returns ``[]``. One seat is not a block, and the per-seat
    pipeline already covers that case — quietly answering "every free seat" here
    would hand the caller a second, contradictory notification path.

    Blocks in the result may contain untracked seats (the bridges). They belong in
    the alert — the user needs the whole block to book it — but the caller must
    not create ``watched_seats`` rows for them: they are not seats the user chose
    to watch.
    """
    if min_size < 2:
        return []

    found: list[list[str]] = []
    for bench in benches:
        for start, end in _block_spans(bench, tracked, new_statuses):
            if end - start + 1 < min_size:
                continue
            # Was this same stretch of seats already holding a block this big? If
            # so the user has heard about it and nothing here is news.
            sub = bench[start : end + 1]
            if _best_block_size(sub, tracked, prev_statuses) >= min_size:
                continue
            found.append(sub)
    return found


def max_possible_block(
    benches: Iterable[list[str]],
    tracked: frozenset[str] | set[str],
) -> int:
    """The largest block ``tracked`` could ever produce, if every seat went free.

    The best case for a selection is that every untracked seat between two of its
    picks becomes bookable, so this is the widest span from a first to a last
    tracked seat within a single bench. A threshold above this number describes a
    watch that can never fire, which is what the seat-selection panel refuses to
    save.

    The check is **not** enforced server-side, and deliberately so: the create
    endpoint runs before ``POST /watches/{id}/seats``, so at create time every
    watch has zero seats and a server-side guard would reject the entire flow.
    This lives here to be verified alongside the rule it mirrors, and so the two
    definitions of "possible" cannot drift apart silently.
    """
    best = 0
    for bench in benches:
        first = next((i for i, seat in enumerate(bench) if seat in tracked), None)
        if first is None:
            continue
        last = next(
            i for i in range(len(bench) - 1, first - 1, -1) if bench[i] in tracked
        )
        best = max(best, last - first + 1)
    return best
