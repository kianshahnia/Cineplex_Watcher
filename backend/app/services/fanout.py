"""Apply one seat selection across a film's other screenings.

The chore this removes: a user who wants seat G4 at whichever showing frees up
first currently has to paste four preview links, pick the same seats four times,
and manage four watches by hand.  Fan-out does it in one call.

**The whole design turns on one measured fact and one measured hazard.**

Cineplex groups its ``alternativeShowtimes`` by *(movie, theatre, day,
auditorium, format)* — so every sibling plays on the same screen, and their seat
maps are therefore key-for-key identical (258 IDs, zero mismatches, verified live
2026-07-24).  Copying a selection across them is a literal copy: no remapping, no
fuzzy matching.

The hazard is what happens if that ever stops holding.  Seat maps of *different*
auditoriums **partially overlap** — Aud 09 (220 seats) and AVX 12 (342 seats)
share 138 keys, where the same key names a different physical seat.  A blind copy
across rooms would produce a watch that looks perfectly healthy on the dashboard
and alerts the user about the wrong seat.  That is worse than an error, so this
module carries **two independent guards**:

1. the target must appear in the anchor's freshly-derived sibling list
   (``services/showtime_alternatives.py`` enforces auditorium equality inside it);
2. every requested seat key must exist in the target's own availability map.

Either one alone would catch the Aud 09 → AVX case.  Both are kept because they
fail independently: guard 1 goes blind if Cineplex changes its grouping
semantics, guard 2 if a seat map is served incomplete.

**Partial success is the contract, not an error path.**  Each target does its own
upstream fetch and its own transaction, so one failure never rolls back the
others and the endpoint never 500s because one target misbehaved.  The caller
renders the per-target outcomes as a list.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.showtime import Showtime
from app.services import cineplex as cineplex_service
from app.services import showtime_alternatives as alternatives_service
from app.services import showtime_metadata as metadata_service
from app.services import watches as watch_service
from app.services.showtime_alternatives import AlternativeShowtime
from app.services.showtime_metadata import ResolvedMetadata

log = structlog.get_logger()

# Outcome statuses. The first three mirror `apply_seats_to_showtime`'s actions;
# the last two are fan-out-level and never reach the watch service.
STATUS_CREATED = "created"
STATUS_UPDATED = "updated"
STATUS_REACTIVATED = "reactivated"
#: The request was understood but deliberately not applied (guard tripped).
STATUS_SKIPPED = "skipped"
#: Something went wrong for this target alone; retrying it is reasonable.
STATUS_FAILED = "failed"


@dataclass(frozen=True)
class FanoutTarget:
    """One showtime to apply seats to.

    Seats are **per target**, not shared, which is what lets one endpoint serve
    both selection modes: "same seats everywhere" simply sends the same list on
    every target.
    """

    showtime_id: int
    #: ``{"seat_key": "1_7_4", "seat_label": "G4"}`` entries, as `add_seats` wants.
    seats: list[dict[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class FanoutOutcome:
    """What happened to one target.  Rendered as one line in the results list."""

    showtime_id: int
    status: str
    watch_id: uuid.UUID | None = None
    #: Total seats now tracked on the resulting watch — not just the ones this
    #: call added.  This is the "watching N seats" number in the results list,
    #: and the only count the client cannot work out from its own request.
    seats_applied: int = 0
    #: Labels of the requested seats that are **already** free at this showtime.
    #: Telling the user beats watching for them; it falls out of the availability
    #: fetch guard 2 does anyway, so it costs nothing.
    already_available: list[str] = field(default_factory=list)
    #: Set on ``skipped`` / ``failed`` — safe to show a user verbatim.
    message: str | None = None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def fan_out_watches(
    *,
    user_id: uuid.UUID,
    theatre_id: int,
    source_showtime_id: int,
    targets: list[FanoutTarget],
    notify_any_seat: bool,
    name: str | None,
    redis,
    db: AsyncSession,
) -> list[FanoutOutcome]:
    """Apply the given selections to each target showtime, independently.

    Returns one outcome per target, in request order.  Never raises for a
    per-target problem — a guard trip becomes ``skipped`` and an upstream or
    database error becomes ``failed``, so a bad target can never take the rest of
    the batch down with it.

    Targets are processed **sequentially**, for two reasons: they share one
    ``AsyncSession`` (which is not safe for concurrent use), and each one costs an
    upstream Cineplex request — the constraint this whole project is bounded by.
    The 8-target cap keeps the worst case small enough that sequential is fine.
    """
    # Guard 1's source of truth, re-derived server-side rather than trusted from
    # the client. Session 1's 5-minute cache means this is normally free (the
    # user just loaded the switcher), but an empty set must be read as "no target
    # is a genuine sibling" — the safe direction — not as "skip the check".
    sibling_set = await alternatives_service.list_alternatives(
        theatre_id, source_showtime_id, redis
    )
    siblings_by_id = {alt.showtime_id: alt for alt in sibling_set.alternatives}

    # The anchor row supplies the movie title, theatre name and metadata blob
    # that seeding copies onto each target (§5.3) — so fan-out costs zero extra
    # metadata requests.
    anchor = await watch_service.get_or_create_showtime(theatre_id, source_showtime_id, db)

    outcomes: list[FanoutOutcome] = []
    for target in targets:
        outcomes.append(
            await _apply_target(
                user_id=user_id,
                theatre_id=theatre_id,
                target=target,
                sibling=siblings_by_id.get(target.showtime_id),
                anchor=anchor,
                notify_any_seat=notify_any_seat,
                name=name,
                db=db,
            )
        )

    await log.ainfo(
        "watch_fanout_complete",
        user_id=str(user_id),
        theatre_id=theatre_id,
        source_showtime_id=source_showtime_id,
        targets=len(targets),
        applied=sum(1 for o in outcomes if o.status not in (STATUS_SKIPPED, STATUS_FAILED)),
    )
    return outcomes


async def _apply_target(
    *,
    user_id: uuid.UUID,
    theatre_id: int,
    target: FanoutTarget,
    sibling: AlternativeShowtime | None,
    anchor: Showtime,
    notify_any_seat: bool,
    name: str | None,
    db: AsyncSession,
) -> FanoutOutcome:
    """Run the full per-target algorithm.  Always returns; never raises."""
    # ---- Guard 1: is this actually a sibling of what the user is looking at? --
    if sibling is None:
        # A client cannot hand us an arbitrary showtime ID and have it treated as
        # seat-map compatible. This also naturally rejects the anchor itself,
        # which the sibling list excludes by construction.
        await log.awarning(
            "fanout_target_not_sibling",
            theatre_id=theatre_id,
            showtime_id=target.showtime_id,
            anchor_showtime_id=anchor.showtime_id,
        )
        return FanoutOutcome(
            showtime_id=target.showtime_id,
            status=STATUS_SKIPPED,
            message="Not another showing of this film on this screen.",
        )

    if not target.seats and not notify_any_seat:
        # An empty watch would poll upstream forever and never notify anyone.
        # Upstream request volume is the binding constraint, so refuse to create
        # one rather than quietly accept a target that can do nothing.
        return FanoutOutcome(
            showtime_id=target.showtime_id,
            status=STATUS_SKIPPED,
            message="No seats selected for this showtime.",
        )

    # ---- Guard 2: does the target's seat map actually contain these keys? -----
    availability = await _fetch_availability(theatre_id, target.showtime_id)
    if availability is None:
        return FanoutOutcome(
            showtime_id=target.showtime_id,
            status=STATUS_FAILED,
            message="Cineplex didn't respond for this showtime.",
        )

    if availability.get("isPostShowtime", False):
        # The sibling list already drops started screenings, but its data rides a
        # 5-minute cache and this response is live — so this catches the showtime
        # that started in between.
        return FanoutOutcome(
            showtime_id=target.showtime_id,
            status=STATUS_SKIPPED,
            message="This screening has already started.",
        )

    statuses: dict[str, str] = availability.get("seatAvailabilities") or {}
    missing = [s["seat_key"] for s in target.seats if s["seat_key"] not in statuses]
    if missing:
        # Guard 1 should have made this unreachable (same auditorium ⇒ same seat
        # map). Loud, because it means the compatibility invariant this feature
        # rests on no longer holds — but we refuse the copy either way, which is
        # the point of having two guards.
        await log.aerror(
            "fanout_seat_map_mismatch",
            theatre_id=theatre_id,
            showtime_id=target.showtime_id,
            anchor_showtime_id=anchor.showtime_id,
            requested=len(target.seats),
            missing=len(missing),
        )
        return FanoutOutcome(
            showtime_id=target.showtime_id,
            status=STATUS_SKIPPED,
            message="This showtime's seat map doesn't match — seats were not copied.",
        )

    # ---- Seed, then apply ----------------------------------------------------
    try:
        await _seed_target_showtime(anchor, sibling, theatre_id, db)
        watch, action = await watch_service.apply_seats_to_showtime(
            user_id=user_id,
            theatre_id=theatre_id,
            showtime_id=target.showtime_id,
            seats=target.seats,
            notify_any_seat=notify_any_seat,
            db=db,
            name=name,
        )
    except (SQLAlchemyError, HTTPException) as exc:
        # Roll back before returning: the session is shared with every remaining
        # target, and one left in an errored state fails their statements too.
        await db.rollback()
        await log.awarning(
            "fanout_target_failed",
            theatre_id=theatre_id,
            showtime_id=target.showtime_id,
            error=str(exc),
        )
        return FanoutOutcome(
            showtime_id=target.showtime_id,
            status=STATUS_FAILED,
            message="Couldn't add this showtime. Try it again.",
        )

    return FanoutOutcome(
        showtime_id=target.showtime_id,
        status=action,
        watch_id=watch.id,
        seats_applied=len(watch.watched_seats),
        already_available=[
            s["seat_label"] for s in target.seats if statuses.get(s["seat_key"]) == "Available"
        ],
    )


async def _fetch_availability(theatre_id: int, showtime_id: int) -> dict[str, Any] | None:
    """Live availability for one target, or ``None`` if upstream wouldn't answer.

    ``fetch_seat_availability`` raises a 502 ``HTTPException`` on any non-200,
    which is right for the single-showtime endpoint and wrong here: one bad
    target must not fail the batch.  Converting it to ``None`` is what makes
    partial success possible.  ``ValueError`` covers the one failure that call
    does *not* wrap — a 200 whose body isn't JSON, which surfaces as a
    ``json.JSONDecodeError``.
    """
    try:
        return await cineplex_service.fetch_seat_availability(theatre_id, showtime_id)
    except (HTTPException, ValueError) as exc:
        await log.awarning(
            "fanout_availability_failed",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            detail=str(getattr(exc, "detail", exc)),
        )
        return None


# ---------------------------------------------------------------------------
# Seeding sibling showtime rows (plan §5.3)
# ---------------------------------------------------------------------------
#
# A fanned-out target's `showtimes` row would normally sit blank until someone
# opened its watch page — and a NULL `showtime_at` means `get_poll_interval`
# falls back to a flat 90 s for it, ignoring the adaptive tiers entirely.  But we
# already know everything that row needs: the sibling entry carries both
# timestamps, and the anchor carries the title, theatre and metadata blob (same
# film, same room, by construction).  So seeding costs **zero** upstream requests
# and puts these showtimes on the correct polling cadence from their first cycle.


def build_sibling_metadata(anchor: Showtime, sibling: AlternativeShowtime) -> ResolvedMetadata:
    """Assemble a target row's metadata from the anchor plus the sibling entry.

    Pure function, so the mapping is verifiable without a database.

    ``metadata_json`` is **copied**, not shared: two ORM rows pointing at one dict
    would let a later in-place edit silently rewrite both.  Its ``auditorium`` is
    taken from the sibling, which is authoritative for its own screening (guard 1
    means they agree anyway).
    """
    metadata_json: dict[str, Any] = dict(anchor.metadata_json or {})
    if metadata_json and sibling.auditorium:
        metadata_json["auditorium"] = sibling.auditorium

    return ResolvedMetadata(
        movie_name=anchor.movie_name,
        theater_name=anchor.theater_name,
        # The sibling's own timestamps — never the anchor's, which are a
        # different screening of the same film.
        showtime_at=sibling.showtime_at,
        showtime_local=sibling.showtime_local,
        metadata_json=metadata_json,
    )


async def _seed_target_showtime(
    anchor: Showtime,
    sibling: AlternativeShowtime,
    theatre_id: int,
    db: AsyncSession,
) -> Showtime:
    """Create the target's ``showtimes`` row and fill it in from what we know.

    Reuses ``persist_showtime_metadata``'s "only overwrite non-NULL" semantics, so
    seeding a row that already exists can never blank a field a real resolution
    filled in.

    If the anchor's own metadata never resolved, this still seeds both timestamps
    (the valuable half — they are what adaptive polling reads) and leaves
    ``movie_name`` NULL, so ``should_resolve`` keeps the row eligible for a proper
    resolution the first time its page is viewed.
    """
    target = await watch_service.get_or_create_showtime(theatre_id, sibling.showtime_id, db)

    if target.movie_name is not None and target.showtime_at is not None:
        # Already fully resolved — a repeat fan-out shouldn't cost a write.
        return target

    resolved = build_sibling_metadata(anchor, sibling)
    if not resolved.is_usable:
        # Nothing worth writing; don't stamp `metadata_fetched_at` for an attempt
        # we never actually made.
        return target

    await metadata_service.persist_showtime_metadata(target, resolved, db)
    await log.ainfo(
        "showtime_metadata_seeded_from_sibling",
        theatre_id=theatre_id,
        showtime_id=sibling.showtime_id,
        anchor_showtime_id=anchor.showtime_id,
    )
    return target
