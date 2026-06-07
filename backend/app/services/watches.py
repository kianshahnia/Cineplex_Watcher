"""Watch service — business logic for creating, querying, and cancelling seat watches."""

import uuid
from datetime import datetime
from typing import Any

import structlog
from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.showtime import Showtime
from app.models.watch import Watch
from app.models.watched_seat import WatchedSeat

log = structlog.get_logger()

# Sentinel so update_watch can tell "field omitted, leave it" apart from
# "field set to None, clear it". A plain None default can't express both.
_UNSET: Any = object()


# ---------------------------------------------------------------------------
# Showtime get-or-create (deduplication)
# ---------------------------------------------------------------------------


async def get_or_create_showtime(
    theatre_id: int,
    showtime_id: int,
    db: AsyncSession,
) -> Showtime:
    """Return the existing Showtime row or create a stub.

    Multiple users can watch the same showtime, so the showtimes table has a
    UNIQUE constraint on (theatre_id, showtime_id).  This function handles that
    deduplication transparently, including a race-condition guard for concurrent
    requests that both try to create the same showtime simultaneously.

    The stub only stores the IDs.  Movie name, theater name, and seat layout are
    populated later by the showtime router (Phase 2 Step 3) when it calls the
    Cineplex API.
    """
    lookup = select(Showtime).where(
        Showtime.theatre_id == theatre_id,
        Showtime.showtime_id == showtime_id,
    )

    result = await db.execute(lookup)
    showtime = result.scalar_one_or_none()
    if showtime is not None:
        return showtime

    showtime = Showtime(theatre_id=theatre_id, showtime_id=showtime_id)
    db.add(showtime)
    try:
        await db.commit()
        await db.refresh(showtime)
    except IntegrityError:
        # Another concurrent request already inserted this showtime.
        await db.rollback()
        result = await db.execute(lookup)
        showtime = result.scalar_one()

    await log.ainfo("showtime_created", theatre_id=theatre_id, showtime_id=showtime_id)
    return showtime


# ---------------------------------------------------------------------------
# Watch CRUD
# ---------------------------------------------------------------------------


async def create_watch(
    user_id: uuid.UUID,
    theatre_id: int,
    showtime_id: int,
    notify_any_seat: bool,
    db: AsyncSession,
    name: str | None = None,
    showtime_at: datetime | None = None,
) -> Watch:
    """Create a new watch for a user + showtime pair.

    Raises 409 only if the user already has an *active* watch for this showtime.
    A previously cancelled / expired / fulfilled watch is reactivated in place
    instead — the UNIQUE(user_id, showtime_id) constraint means we can never
    insert a second row, so reusing the existing one is the only way to let a
    user re-watch a showtime they previously stopped watching.
    Reuses the existing Showtime row if another user already created one.
    ``name`` is an optional user-provided label for the watch; ``showtime_at``
    is the optional user-picked screening date/time (naive, theatre-local).
    """
    showtime = await get_or_create_showtime(theatre_id, showtime_id, db)

    # Look up any prior watch for this (user, showtime) — the unique constraint
    # guarantees at most one row, regardless of status.
    existing_stmt = select(Watch).where(
        Watch.user_id == user_id,
        Watch.showtime_id == showtime.id,
    )
    result = await db.execute(existing_stmt)
    existing = result.scalar_one_or_none()

    if existing is not None:
        if existing.status == "active":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You are already watching this showtime.",
            )
        # Reactivate a stopped watch (cancelled / expired / fulfilled). Clear
        # its old seats so the caller starts from a clean slate — this is the
        # "cancel a watch to change its seats, then recreate" workflow. The
        # bulk DELETE cascades to seat_events via the ON DELETE CASCADE FK, so
        # we don't need to eager-load the child tree (cf. delete_watch).
        await db.execute(delete(WatchedSeat).where(WatchedSeat.watch_id == existing.id))
        existing.status = "active"
        existing.notify_any_seat = notify_any_seat
        existing.name = name
        existing.showtime_at = showtime_at
        await db.commit()

        await log.ainfo(
            "watch_reactivated", watch_id=str(existing.id), user_id=str(user_id)
        )
        return await _load_watch(existing.id, db)

    watch = Watch(
        user_id=user_id,
        showtime_id=showtime.id,
        notify_any_seat=notify_any_seat,
        name=name,
        showtime_at=showtime_at,
    )
    db.add(watch)
    await db.commit()
    await db.refresh(watch)

    await log.ainfo("watch_created", watch_id=str(watch.id), user_id=str(user_id))
    return await _load_watch(watch.id, db)


async def update_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
    *,
    name: str | None = _UNSET,
    showtime_at: datetime | None = _UNSET,
) -> Watch:
    """Update a watch's editable fields (name and/or showtime date/time).

    Both fields are editable at any time and for any status (e.g. relabelling
    an old fulfilled watch in history). Each argument defaults to the ``_UNSET``
    sentinel: only the fields actually passed are written, so a name-only update
    leaves ``showtime_at`` alone and vice-versa. Passing ``None`` explicitly
    clears that field. Raises 403 if the caller doesn't own it, 404 if it
    doesn't exist.
    """
    watch = await _get_own_watch(watch_id, user_id, db)
    if name is not _UNSET:
        watch.name = name
    if showtime_at is not _UNSET:
        watch.showtime_at = showtime_at
    await db.commit()

    await log.ainfo("watch_updated", watch_id=str(watch_id), user_id=str(user_id))
    return await _load_watch(watch_id, db)


async def add_seats(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    seats: list[dict[str, str]],
    db: AsyncSession,
) -> Watch:
    """Append seats to an existing watch.

    Each entry in `seats` must have ``seat_key`` and ``seat_label``.
    Already-tracked seats are silently skipped (idempotent).
    Raises 400 if the watch is not active, 403 if the caller doesn't own it.
    """
    await _require_active_watch(watch_id, user_id, db)

    # Fetch the set of seat keys already tracked for this watch in one query
    # so we avoid N separate existence checks inside the loop.
    existing_stmt = select(WatchedSeat.seat_key).where(WatchedSeat.watch_id == watch_id)
    result = await db.execute(existing_stmt)
    already_tracked: set[str] = {row[0] for row in result.all()}

    new_seats = [
        WatchedSeat(
            watch_id=watch_id,
            seat_key=s["seat_key"],
            seat_label=s["seat_label"],
        )
        for s in seats
        if s["seat_key"] not in already_tracked
    ]

    if new_seats:
        db.add_all(new_seats)
        await db.commit()

    await log.ainfo(
        "seats_added",
        watch_id=str(watch_id),
        added=len(new_seats),
        skipped=len(seats) - len(new_seats),
    )
    return await _load_watch(watch_id, db)


async def list_watches(
    user_id: uuid.UUID,
    status_filter: str | None,
    db: AsyncSession,
) -> list[Watch]:
    """Return all of a user's watches, optionally filtered by status.

    Passing ``status_filter=None`` returns every watch regardless of status.
    Results are ordered newest-first.
    """
    stmt = (
        select(Watch)
        .where(Watch.user_id == user_id)
        .options(
            selectinload(Watch.watched_seats),
            selectinload(Watch.showtime),
        )
        .order_by(Watch.created_at.desc())
    )
    if status_filter is not None:
        stmt = stmt.where(Watch.status == status_filter)

    result = await db.execute(stmt)
    return list(result.scalars().all())


async def cancel_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> Watch:
    """Soft-cancel a watch by setting its status to 'cancelled'.

    The row is kept for audit history.  Raises 400 if already cancelled/expired,
    403 if the caller doesn't own it, 404 if it doesn't exist.
    """
    watch = await _get_own_watch(watch_id, user_id, db)

    if watch.status in ("cancelled", "expired"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Watch is already '{watch.status}'.",
        )

    watch.status = "cancelled"
    await db.commit()

    await log.ainfo("watch_cancelled", watch_id=str(watch_id), user_id=str(user_id))
    return await _load_watch(watch_id, db)


async def delete_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    """Permanently delete a watch and everything hanging off it.

    Unlike :func:`cancel_watch` (a soft-delete that preserves history), this
    removes the row entirely.  ``watched_seats`` and ``seat_events`` cascade
    away via their ``ON DELETE CASCADE`` foreign keys.  Used by the dashboard
    "Remove" action so users can clear out finished / cancelled / expired
    watches that the soft-delete would otherwise leave lingering forever.

    Raises 403 if the caller doesn't own it, 404 if it doesn't exist.
    """
    # Eager-load the full child tree: both watched_seats and their seat_events
    # use cascade="all, delete-orphan" without passive_deletes, so SQLAlchemy
    # needs the collections in memory to cascade the delete. Without this, the
    # async flush would trigger a lazy load and raise MissingGreenlet.
    stmt = (
        select(Watch)
        .where(Watch.id == watch_id)
        .options(
            selectinload(Watch.watched_seats).selectinload(WatchedSeat.seat_events)
        )
    )
    result = await db.execute(stmt)
    watch = result.scalar_one_or_none()

    if watch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watch not found.")
    if watch.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your watch.")

    await db.delete(watch)
    await db.commit()

    await log.ainfo("watch_deleted", watch_id=str(watch_id), user_id=str(user_id))


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


async def _get_own_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> Watch:
    """Fetch a watch by ID, enforcing ownership. Raises 404 or 403."""
    stmt = select(Watch).where(Watch.id == watch_id)
    result = await db.execute(stmt)
    watch = result.scalar_one_or_none()

    if watch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watch not found.")
    if watch.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your watch.")
    return watch


async def _require_active_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> Watch:
    """Like _get_own_watch but also requires status == 'active'."""
    watch = await _get_own_watch(watch_id, user_id, db)
    if watch.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot modify a watch with status '{watch.status}'.",
        )
    return watch


async def _load_watch(watch_id: uuid.UUID, db: AsyncSession) -> Watch:
    """Re-fetch a watch with its relationships eagerly loaded for serialization."""
    stmt = (
        select(Watch)
        .where(Watch.id == watch_id)
        .options(
            selectinload(Watch.watched_seats),
            selectinload(Watch.showtime),
        )
    )
    result = await db.execute(stmt)
    return result.scalar_one()
